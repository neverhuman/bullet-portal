import { describe, expect, it } from "vitest";
import type { SseFrame } from "../sse";
import { createSseParser } from "../sse";
import { createTracker, parseFrame, snapshotCoversGap } from "./useEventStream";

const EVENT_ID = "9".repeat(64);

describe("sse parser", () => {
  it("parses default messages with ids and skips keep-alive comments", () => {
    const frames: SseFrame[] = [];
    const feed = createSseParser((frame) => frames.push(frame));
    feed('id: 1\ndata: {"seq":1}\n\n: keep-alive\n\nid: 2\nda');
    feed('ta: {"seq":2}\n\n');
    expect(frames).toEqual([
      { id: "1", event: "message", data: '{"seq":1}' },
      { id: "2", event: "message", data: '{"seq":2}' },
    ]);
  });

  it("rejects a malformed payload instead of treating transport metadata as truth", () => {
    const parsed = parseFrame({ id: "7", event: "encoding_failure", data: "not json" });
    expect(parsed).toBeNull();
  });

  it("prefers durable id, sequence, and time from the EventEnvelope", () => {
    const parsed = parseFrame({
      id: "9",
      event: "message",
      data: `{"id":"${EVENT_ID}","seq":9,"at":"2026-08-24T09:00:00Z","kind":"graph_delta","body":"{}"}`,
    });
    expect(parsed).toEqual({ id: EVENT_ID, seq: 9, at: "2026-08-24T09:00:00Z" });
  });

  it("rejects a sequence mismatch between the SSE id and envelope", () => {
    expect(
      parseFrame({
        id: "8",
        event: "message",
        data: `{"id":"${EVENT_ID}","seq":9,"at":"2026-08-24T09:00:00Z","kind":"x","body":"{}"}`,
      }),
    ).toBeNull();
  });
});

describe("event tracker", () => {
  it("dedupes ids, enforces monotonic seq, and flags gaps", () => {
    const tracker = createTracker(8);
    expect(tracker.accept({ id: "a", seq: 1, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "a", seq: 1, at: "t" })).toBe("duplicate");
    expect(tracker.accept({ id: "b", seq: 1, at: "t" })).toBe("gap");
    expect(tracker.accept({ id: "c", seq: 2, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "d", seq: 5, at: "t" })).toBe("gap");
    expect(tracker.lastSeq()).toBe(2);
    expect(tracker.stale()).toBe(true);
    expect(tracker.requiredThrough()).toBe(5);
  });

  it("treats reused ids and unrecognized old sequences as conflicts, not duplicates", () => {
    const reusedId = createTracker(8);
    expect(reusedId.accept({ id: "a", seq: 1, at: "t" })).toBe("ok");
    expect(reusedId.accept({ id: "a", seq: 2, at: "t" })).toBe("gap");
    expect(reusedId.lastSeq()).toBe(1);
    expect(reusedId.applySnapshot(1)).toBe(false);
    expect(reusedId.applySnapshot(2)).toBe(true);

    const evicted = createTracker(1);
    expect(evicted.accept({ id: "a", seq: 1, at: "t" })).toBe("ok");
    expect(evicted.accept({ id: "b", seq: 2, at: "t" })).toBe("ok");
    expect(evicted.accept({ id: "a", seq: 1, at: "t" })).toBe("gap");
    expect(evicted.lastSeq()).toBe(2);
    expect(evicted.requiredThrough()).toBe(3);
  });

  it("keeps cursor 2 and STALE after 1,2,4 until a watermark covers 4", () => {
    const tracker = createTracker(8);
    expect(tracker.accept({ id: "1", seq: 1, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "2", seq: 2, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "4", seq: 4, at: "t" })).toBe("gap");
    expect(tracker.lastSeq()).toBe(2);
    expect(tracker.stale()).toBe(true);
    expect(tracker.applySnapshot(null)).toBe(false);
    expect(tracker.lastSeq()).toBe(2);
    expect(tracker.stale()).toBe(true);
    expect(tracker.applySnapshot(3)).toBe(false);
    expect(tracker.lastSeq()).toBe(2);
    expect(tracker.stale()).toBe(true);
    expect(tracker.applySnapshot(4)).toBe(true);
    expect(tracker.lastSeq()).toBe(4);
    expect(tracker.stale()).toBe(false);
  });

  it("detects a first-event gap from exclusive cursor zero", () => {
    const tracker = createTracker(8);
    expect(tracker.accept({ id: "4", seq: 4, at: "t" })).toBe("gap");
    expect(tracker.lastSeq()).toBe(0);
    expect(tracker.stale()).toBe(true);
    expect(tracker.applySnapshot(3)).toBe(false);
    expect(tracker.applySnapshot(4)).toBe(true);
  });

  it("marks disconnect uncertainty and clears it only by replay or a newer snapshot", () => {
    const tracker = createTracker(8);
    expect(tracker.applySnapshot(2)).toBe(true);
    tracker.markUncertain();
    expect(tracker.requiredThrough()).toBe(3);
    expect(tracker.applySnapshot(2)).toBe(false);
    expect(tracker.lastSeq()).toBe(2);
    expect(tracker.stale()).toBe(true);
    expect(tracker.accept({ id: "3", seq: 3, at: "t" })).toBe("ok");
    expect(tracker.lastSeq()).toBe(3);
    expect(tracker.stale()).toBe(false);
  });

  it("fails closed when the acknowledged sequence exhausts safe integers", () => {
    const tracker = createTracker(8);
    expect(tracker.applySnapshot(Number.MAX_SAFE_INTEGER)).toBe(true);
    tracker.markUncertain();
    expect(tracker.stale()).toBe(true);
    expect(tracker.applySnapshot(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(tracker.stale()).toBe(true);
  });
});
