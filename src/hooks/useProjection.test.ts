import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SnapshotRead } from "../api";
import { atomicSnapshot, useProjection, type ProjectionRead } from "./useProjection";

const early = "2026-09-08T20:00:00.000Z";
const late = "2026-09-08T20:01:00.000Z";
function read(observedAt = early): SnapshotRead<null> {
  return { data: null, asOfSequence: 7, observedAt, source: "bullet-kernel/sqlite-ledger" };
}
function projection(body: string): ProjectionRead<string> {
  return { reads: [read()], body };
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
  it("renders a mounted read failure as local unknown", async () => {
    const load = () => Promise.reject(new Error("connection lost"));
    const { result } = renderHook(() => useProjection("Fleet", load));
    expect(result.current).toEqual({ kind: "loading" });
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
      expect(result.current).toEqual({ kind: "loading" });
      rerender({ load: nextLoad });
      await waitFor(() => expect(result.current).toMatchObject({ kind: "value", body: "current rows" }));
      const current = result.current;
      await act(async () => {
        if (outcome === "resolve") old.resolve(projection("stale rows"));
        else old.reject(new Error("stale failure"));
        await Promise.resolve();
      });
      expect(result.current).toBe(current);
      expect(result.current).toMatchObject({ kind: "value", body: "current rows" });
    },
  );
});
