import { describe, expect, it } from "vitest";
import type { SseFrame } from "../sse";
import { createSseParser } from "../sse";
import { createTracker, parseFrame, snapshotCoversGap } from "./useEventStream";

describe("sse parser", () => {
  it("parses named events with ids and skips keep-alive comments", () => {
    const frames: SseFrame[] = [];
    const feed = createSseParser((frame) => frames.push(frame));
    feed('id: 1\nevent: candidate_prepared\ndata: {"seq":1}\n\n: keep-alive\n\nid: 2\nev');
    feed('ent: effect_receipt\ndata: {"seq":2}\n\n');
    expect(frames).toEqual([
      { id: "1", event: "candidate_prepared", data: '{"seq":1}' },
      { id: "2", event: "effect_receipt", data: '{"seq":2}' },
    ]);
  });

  it("falls back to the SSE id when the payload is not JSON", () => {
    const parsed = parseFrame({ id: "7", event: "encoding_failure", data: "not json" });
    expect(parsed.seq).toBe(7);
    expect(parsed.id).toBe("7");
  });

  it("prefers event_id and seq from the Event JSON", () => {
    const parsed = parseFrame({
      id: "9",
      event: "graph_delta",
      data: '{"seq":9,"kind":"graph_delta","body":"{}","event_id":"evt_9"}',
    });
    expect(parsed.seq).toBe(9);
    expect(parsed.id).toBe("evt_9");
  });
});

describe("event tracker", () => {
  it("dedupes ids, enforces monotonic seq, and flags gaps", () => {
    const tracker = createTracker(8);
    expect(tracker.accept({ id: "a", seq: 1, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "a", seq: 2, at: "t" })).toBe("duplicate");
    expect(tracker.accept({ id: "b", seq: 1, at: "t" })).toBe("duplicate");
    expect(tracker.accept({ id: "c", seq: 2, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "d", seq: 5, at: "t" })).toBe("gap");
    expect(tracker.lastSeq()).toBe(2);
  });

  it("keeps cursor 2 after 1,2,4 until a watermark covers 4", () => {
    const tracker = createTracker(8);
    expect(tracker.accept({ id: "1", seq: 1, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "2", seq: 2, at: "t" })).toBe("ok");
    expect(tracker.accept({ id: "4", seq: 4, at: "t" })).toBe("gap");
    expect(tracker.lastSeq()).toBe(2);
    expect(snapshotCoversGap(4, null)).toBe(false);
    expect(snapshotCoversGap(4, 3)).toBe(false);
    expect(snapshotCoversGap(4, 4)).toBe(true);
    tracker.coverThrough(4);
    expect(tracker.lastSeq()).toBe(4);
  });

  it("detects a first-event gap from exclusive cursor zero", () => {
    const tracker = createTracker(8);
    expect(tracker.accept({ id: "4", seq: 4, at: "t" })).toBe("gap");
    expect(tracker.lastSeq()).toBe(0);
  });
});
