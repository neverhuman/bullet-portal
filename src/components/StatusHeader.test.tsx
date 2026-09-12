import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStreamState } from "../hooks/useEventStream";
import type { ProjectionLoad } from "../hooks/useProjection";
import { StatusHeader } from "./StatusHeader";

const AT = "2026-09-11T00:00:10.000Z";
const stream: EventStreamState = {
  connection: "live",
  detail: "",
  asOfSequence: 8,
  lastEventAt: "2026-09-11T00:00:05.000Z",
  stale: false,
};
const health = { kind: "value", value: "ok", observedAt: AT, source: "farmd" } as const;

function snapshot(asOf: number): ProjectionLoad<unknown> {
  return { kind: "value", asOf, observedAt: AT, source: "bullet-kernel/sqlite-ledger", body: {}, stream };
}

describe("StatusHeader observation boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("advances visible lag while mounted and releases its clock on unmount", () => {
    const view = render(<StatusHeader stream={stream} health={health} />);
    expect(screen.getByTestId("projection-lag")).toHaveTextContent("projection lag: 5s");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByTestId("projection-lag")).toHaveTextContent("projection lag: 7s");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [null, "unknown (no events received)"],
    ["not a timestamp", "unknown (unparseable event time)"],
  ])("keeps unavailable event time %s explicitly unknown", (lastEventAt, expected) => {
    render(<StatusHeader stream={{ ...stream, lastEventAt }} health={health} />);
    expect(screen.getByTestId("projection-lag")).toHaveTextContent(`projection lag: ${expected}`);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByTestId("projection-lag")).toHaveTextContent(`projection lag: ${expected}`);
  });

  it("does not display negative lag when the event clock is ahead", () => {
    render(<StatusHeader stream={{ ...stream, lastEventAt: "2026-09-11T00:00:15.000Z" }} health={health} />);
    expect(screen.getByTestId("projection-lag")).toHaveTextContent("projection lag: 0s");
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.getByTestId("projection-lag")).toHaveTextContent("projection lag: 2s");
  });

  it.each<ProjectionLoad<unknown>>([
    { kind: "loading", stream },
    { kind: "unknown", text: "snapshot request refused", observedAt: AT, source: "portal/local", stream },
  ])("does not borrow the event cursor for a $kind snapshot", (load) => {
    render(<StatusHeader stream={stream} health={health} snapshot={load} />);
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: unknown");
    expect(screen.getByTestId("event-cursor")).toHaveTextContent("event cursor: 8");
  });

  it("keeps the snapshot watermark separate until its own read catches up", () => {
    const view = render(<StatusHeader stream={stream} health={health} snapshot={snapshot(5)} />);
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: 5");
    expect(screen.getByTestId("event-cursor")).toHaveTextContent("event cursor: 8");
    expect(screen.getByTestId("stale-badge")).toHaveTextContent("STALE");
    view.rerender(<StatusHeader stream={stream} health={health} snapshot={snapshot(8)} />);
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: 8");
    expect(screen.queryByTestId("stale-badge")).toBeNull();
  });

  it("retains unresolved event continuity even when a snapshot reaches the cursor", () => {
    const gap = { ...stream, stale: true, connection: "reconnecting" as const, detail: "connection lost" };
    render(<StatusHeader stream={gap} health={health} snapshot={{ ...snapshot(8), stream: gap }} />);
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: 8");
    expect(screen.getByTestId("event-continuity")).toHaveTextContent("event continuity: unresolved");
    expect(screen.getByTestId("stream-connection")).toHaveTextContent("events: reconnecting (connection lost)");
    expect(screen.getByTestId("stale-badge")).toHaveTextContent("STALE");
  });

  it("distinguishes a failed health observation from checking and an observed value", () => {
    const unknownStream = { ...stream, asOfSequence: null, lastEventAt: null, connection: "unknown" as const };
    const view = render(<StatusHeader stream={unknownStream} health={{ kind: "loading" }} />);
    expect(screen.getByTestId("health-probe")).toHaveTextContent("farmd /health: checking");
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: unknown");
    view.rerender(<StatusHeader stream={unknownStream} health={{ kind: "unknown", reason: "connection refused", observedAt: AT, source: "portal/local" }} />);
    expect(screen.getByTestId("health-probe")).toHaveTextContent(`unknown: connection refused (observed ${AT})`);
    expect(screen.getByTestId("health-probe")).toHaveClass("unknown");
    view.rerender(<StatusHeader stream={stream} health={{ ...health, value: "warming" }} />);
    expect(screen.getByTestId("health-probe")).toHaveTextContent(`warming (observed ${AT})`);
    expect(screen.getByTestId("health-probe")).toHaveClass("pending");
    view.rerender(<StatusHeader stream={stream} health={health} />);
    expect(screen.getByTestId("health-probe")).toHaveTextContent(`ok (observed ${AT})`);
    expect(screen.getByTestId("health-probe")).toHaveClass("idle");
    expect(view.container.querySelector(".verified")).toBeNull();
  });
});
