import { useEffect, useRef, useState } from "react";
import { apiBase } from "../api";
import type { SseFrame } from "../sse";
import { readSseStream } from "../sse";

export type StreamConnection = "live" | "reconnecting" | "unknown";

export type EventStreamState = {
  connection: StreamConnection;
  detail: string;
  asOfSequence: number | null;
  lastEventAt: string | null;
  stale: boolean;
};

const RETRY_MS = 10_000;
const SEEN_ID_CAP = 1024;

const INITIAL: EventStreamState = {
  connection: "unknown",
  detail: "events stream unavailable",
  asOfSequence: null,
  lastEventAt: null,
  stale: false,
};

export type ParsedEvent = { id: string; seq: number; at: string };

/**
 * Kernel framing: SSE id = ledger seq and default-message data = EventEnvelope.
 */
export function parseFrame(frame: SseFrame): ParsedEvent | null {
  if (frame.event !== "message" || frame.id === null || !/^\d+$/.test(frame.id)) {
    return null;
  }
  let record: Record<string, unknown>;
  try {
    const data: unknown = JSON.parse(frame.data);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    record = data as Record<string, unknown>;
  } catch {
    return null;
  }
  const frameSequence = Number(frame.id);
  if (
    !Number.isSafeInteger(frameSequence) ||
    frameSequence < 0 ||
    typeof record.seq !== "number" ||
    !Number.isSafeInteger(record.seq) ||
    record.seq !== frameSequence ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.at !== "string" ||
    Number.isNaN(Date.parse(record.at)) ||
    typeof record.kind !== "string" ||
    typeof record.body !== "string"
  ) {
    return null;
  }
  return { id: record.id, seq: record.seq, at: record.at };
}

type Verdict = "duplicate" | "ok" | "gap";

export type Tracker = {
  lastSeq: () => number;
  stale: () => boolean;
  requiredThrough: () => number | null;
  accept: (event: ParsedEvent) => Verdict;
  markUncertain: () => void;
  applySnapshot: (watermark: number | null) => boolean;
};

export function createTracker(cap: number): Tracker {
  const seen = new Set<string>();
  const order: string[] = [];
  let lastSeq = 0;
  let requiredThrough: number | null = null;
  return {
    lastSeq: () => lastSeq,
    stale: () => requiredThrough !== null,
    requiredThrough: () => requiredThrough,
    accept(event) {
      if (seen.has(event.id)) {
        return "duplicate";
      }
      if (event.seq <= lastSeq) {
        return "duplicate";
      }
      if (event.seq > lastSeq + 1) {
        requiredThrough = Math.max(requiredThrough ?? 0, event.seq);
        return "gap";
      }
      lastSeq = event.seq;
      rememberId(event.id, seen, order, cap);
      if (requiredThrough !== null && lastSeq >= requiredThrough) {
        requiredThrough = null;
      }
      return "ok";
    },
    markUncertain() {
      const next = lastSeq + 1;
      requiredThrough = Math.max(requiredThrough ?? 0, next);
    },
    applySnapshot(watermark) {
      const required = requiredThrough ?? lastSeq;
      if (!snapshotCoversGap(required, watermark)) {
        return false;
      }
      lastSeq = watermark;
      requiredThrough = null;
      return true;
    },
  };
}

function rememberId(id: string, seen: Set<string>, order: string[], cap: number): void {
  seen.add(id);
  order.push(id);
  if (order.length > cap) {
    const oldest = order.shift();
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
}

export function snapshotCoversGap(required: number, watermark: number | null): watermark is number {
  return watermark !== null && Number.isSafeInteger(watermark) && watermark >= required;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

type StreamCallbacks = {
  patch: (next: Partial<EventStreamState>) => void;
  onGap: (requiredSequence: number) => Promise<number | null>;
};

function createStream(cb: StreamCallbacks): () => void {
  const tracker = createTracker(SEEN_ID_CAP);
  const controller = new AbortController();
  let disposed = false;
  let everConnected = false;
  let reconnect = false;
  let recovery: Promise<void> | null = null;

  const patchCursor = (lastEventAt?: string): void => {
    cb.patch({
      stale: tracker.stale(),
      asOfSequence: tracker.lastSeq(),
      ...(lastEventAt === undefined ? {} : { lastEventAt }),
    });
  };

  const recover = (): Promise<void> => {
    if (recovery !== null) {
      return recovery;
    }
    const required = tracker.requiredThrough() ?? tracker.lastSeq();
    recovery = cb.onGap(required).then(
      (watermark) => {
        if (!disposed && tracker.applySnapshot(watermark)) {
          patchCursor();
        } else if (!disposed) {
          cb.patch({ stale: tracker.stale() });
        }
      },
      () => {
        if (!disposed) {
          cb.patch({ stale: tracker.stale() });
        }
      },
    ).finally(() => {
      recovery = null;
    });
    return recovery;
  };

  const handleFrame = (frame: SseFrame): void => {
    const event = parseFrame(frame);
    if (event === null) {
      tracker.markUncertain();
      patchCursor();
      void recover();
      return;
    }
    const verdict = tracker.accept(event);
    if (verdict === "duplicate") {
      return;
    }
    if (verdict === "gap") {
      patchCursor(event.at);
      void recover();
      return;
    }
    patchCursor(event.at);
  };

  const markDown = (): void => {
    tracker.markUncertain();
    cb.patch({
      stale: true,
      asOfSequence: tracker.lastSeq(),
      ...(
      everConnected
        ? { connection: "reconnecting" as const, detail: "connection lost, retrying" }
        : { connection: "unknown" as const, detail: "events stream unavailable" }
      ),
    });
  };

  const loop = async (): Promise<void> => {
    try {
      const watermark = await cb.onGap(tracker.lastSeq());
      if (!disposed && tracker.applySnapshot(watermark)) {
        patchCursor();
      }
    } catch {
      // The endpoint-specific loadables carry initial snapshot failure details.
    }
    while (!disposed) {
      if (reconnect && tracker.stale()) {
        await recover();
      }
      try {
        const cursor = tracker.lastSeq();
        const url = reconnect
          ? `${apiBase}/v1/events`
          : `${apiBase}/v1/events?after=${cursor}`;
        await readSseStream(
          url,
          controller.signal,
          {
            onOpen: () => {
              everConnected = true;
              cb.patch({ connection: "live", detail: "" });
            },
            onFrame: handleFrame,
          },
          reconnect ? cursor : undefined,
        );
      } catch {
        // fall through to markDown + retry
      }
      if (disposed) {
        return;
      }
      markDown();
      reconnect = true;
      await delay(RETRY_MS, controller.signal);
    }
  };

  void loop();
  return () => {
    disposed = true;
    controller.abort();
  };
}

export function useEventStream(
  onGap: (requiredSequence: number) => Promise<number | null>,
): EventStreamState {
  const [state, setState] = useState<EventStreamState>(INITIAL);
  const onGapRef = useRef(onGap);
  onGapRef.current = onGap;

  useEffect(() => {
    let disposed = false;
    const dispose = createStream({
      patch: (next) => {
        if (!disposed) {
          setState((prev) => ({ ...prev, ...next }));
        }
      },
      onGap: (requiredSequence) => onGapRef.current(requiredSequence),
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  return state;
}
