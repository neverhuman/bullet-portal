import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotRead } from "../api";
import type { SseCallbacks } from "../sse";
import { atomicSnapshot, useProjection, type ProjectionRead } from "./useProjection";

const transport = vi.hoisted(() => ({ callbacks: [] as SseCallbacks[], cursors: [] as (number | undefined)[] }));
vi.mock("../sse", () => ({
  readSseStream: (_url: string, signal: AbortSignal, callbacks: SseCallbacks, cursor?: number) => {
    transport.callbacks.push(callbacks);
    transport.cursors.push(cursor);
    callbacks.onOpen();
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  },
}));
beforeEach(() => { transport.callbacks = []; transport.cursors = []; });
afterEach(() => { vi.restoreAllMocks(); });

const early = "2026-09-08T20:00:00.000Z";
const late = "2026-09-08T20:01:00.000Z";
function read(observedAt = early): SnapshotRead<null> {
  return { data: null, asOfSequence: 7, observedAt, source: "bullet-kernel/sqlite-ledger" };
}
function projection(body: string, sequence = 7): ProjectionRead<string> {
  return { reads: [{ ...read(), asOfSequence: sequence }], body };
}
function event(sequence: number) {
  const value = { id: sequence.toString(16).padStart(64, "0"), seq: sequence, at: late, kind: "attempt_changed", body: "{}" };
  transport.callbacks.at(-1)!.onFrame({ id: String(sequence), event: "message", data: JSON.stringify(value) });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("atomic projection reads", () => {
  it("refuses a projection without a snapshot subject", () => {
    expect(() => atomicSnapshot([])).toThrow("SNAPSHOT_WATERMARK_MISSING");
  });

  it.each<[string, SnapshotRead<null>, string]>([
    ["sequence", { ...read(), asOfSequence: 8 }, "SNAPSHOT_WATERMARK_MISMATCH"],
    // Deliberately violate the fixed source type to exercise the runtime guard.
    ["source", { ...read(), source: "other-ledger" as SnapshotRead<null>["source"] }, "SNAPSHOT_SOURCE_MISMATCH"],
  ])("refuses inconsistent %s rather than combining rows", (_label, other, error) => {
    expect(() => atomicSnapshot([read(), other])).toThrow(error);
  });

  it("retains the latest observation time regardless of read order", () => {
    for (const reads of [[read(early), read(late)], [read(late), read(early)]]) {
      expect(atomicSnapshot(reads)).toEqual({
        asOf: 7, observedAt: late, source: "bullet-kernel/sqlite-ledger",
      });
    }
  });
});

describe("projection lifecycle", () => {
  it("rebases a gap from a covering successor snapshot after joining an older read", async () => {
    const pending = deferred<ProjectionRead<string>>();
    const load = vi.fn().mockResolvedValueOnce(projection("old"))
      .mockImplementationOnce(() => pending.promise).mockResolvedValue(projection("recovered", 10));
    const { result } = renderHook(() => useProjection("Fleet", load));
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 7, stream: { connection: "live" } }));
    act(() => event(8));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    act(() => event(10));
    expect(result.current).toMatchObject({ stream: { stale: true, asOfSequence: 8 } });
    await act(async () => pending.resolve(projection("insufficient", 8)));
    expect(result.current).toMatchObject({ stream: { stale: true, asOfSequence: 8 } });
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 10, stream: { stale: false, asOfSequence: 10, connection: "live" } }));
    expect(transport.cursors).toEqual([undefined, 10]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("refreshes ordinary events, coalesces bursts, and does not refresh duplicate frames", async () => {
    const load = vi.fn().mockResolvedValueOnce(projection("old rows"))
      .mockResolvedValue(projection("new rows", 10));
    const { result } = renderHook(() => useProjection("Fleet", load));
    await waitFor(() => expect(result.current).toMatchObject({ kind: "value", asOf: 7, stream: { connection: "live" } }));
    act(() => { event(8); event(8); event(9); event(10); });
    expect(result.current).toMatchObject({ asOf: 7, stream: { asOfSequence: 10 } });
    expect(load).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 10, body: "new rows" }));
    expect(load).toHaveBeenCalledTimes(2);
    act(() => event(10));
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retains events received during a pending refresh and fetches one successor", async () => {
    const pending = deferred<ProjectionRead<string>>();
    const load = vi.fn().mockResolvedValueOnce(projection("old"))
      .mockImplementationOnce(() => pending.promise).mockResolvedValue(projection("latest", 9));
    const { result } = renderHook(() => useProjection("Fleet", load));
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 7 }));
    act(() => event(8));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    act(() => { event(9); result.current.refresh?.(); result.current.refresh?.(); });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(projection("intermediate", 8)));
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 9, body: "latest" }));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("refuses regressing snapshots and exposes read failures until a successful refresh", async () => {
    const load = vi.fn().mockResolvedValueOnce(projection("old"))
      .mockResolvedValueOnce(projection("rollback", 6))
      .mockRejectedValueOnce(new Error("session expired"))
      .mockResolvedValue(projection("current", 8));
    const { result } = renderHook(() => useProjection("Fleet", load));
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 7 }));
    act(() => result.current.refresh?.());
    await waitFor(() => expect(result.current).toMatchObject({ kind: "unknown", text: expect.stringContaining("SNAPSHOT_SEQUENCE_REGRESSION") }));
    act(() => result.current.refresh?.());
    await waitFor(() => expect(result.current).toMatchObject({ kind: "unknown", text: expect.stringContaining("session expired") }));
    act(() => result.current.refresh?.());
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 8, body: "current" }));
  });

  it("cancels a scheduled event refresh on unmount", async () => {
    const load = vi.fn().mockResolvedValue(projection("old"));
    const { result, unmount } = renderHook(() => useProjection("Fleet", load));
    await waitFor(() => expect(result.current).toMatchObject({ asOf: 7 }));
    act(() => event(8));
    unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("renders a mounted read failure as local unknown", async () => {
    const load = () => Promise.reject(new Error("connection lost"));
    const { result } = renderHook(() => useProjection("Fleet", load));
    expect(result.current).toMatchObject({ kind: "loading" });
    await waitFor(() => expect(result.current).toMatchObject({
      kind: "unknown", source: "portal/local",
      text: "Fleet: control plane unreachable (connection lost)",
    }));
  });

  it.each(["resolve", "reject"] as const)(
    "keeps the active projection when a disposed loader later %ss",
    async (outcome) => {
      const old = deferred<ProjectionRead<string>>();
      const firstLoad = () => old.promise;
      const nextLoad = () => Promise.resolve(projection("current rows"));
      const { result, rerender } = renderHook(
        ({ load }) => useProjection("Fleet", load), { initialProps: { load: firstLoad } },
      );
      expect(result.current).toMatchObject({ kind: "loading" });
      rerender({ load: nextLoad });
      await waitFor(() => expect(result.current).toMatchObject({ kind: "value", body: "current rows" }));
      const current = result.current;
      await act(async () => {
        if (outcome === "resolve") old.resolve(projection("stale rows"));
        else old.reject(new Error("stale failure"));
        await Promise.resolve();
      });
      expect(result.current.kind).toBe(current.kind);
      expect(result.current).toMatchObject({ kind: "value", body: "current rows" });
    },
  );
});
