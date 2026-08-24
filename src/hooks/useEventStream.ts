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

export type ParsedEvent = { id: string | null; seq: number | null; at: string | null };

/**
 * Kernel framing: SSE id = ledger seq and default-message data = EventEnvelope.
 */
export function parseFrame(frame: SseFrame): ParsedEvent {
  let record: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(frame.data);
    if (typeof data === "object" && data !== null) {
      record = data as Record<string, unknown>;
    }
  } catch {
    record = {};
  }
  const seqFromData =
    typeof record.seq === "number" && Number.isSafeInteger(record.seq) && record.seq >= 0
      ? record.seq
      : null;
  const seqFromId = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
  const seq = seqFromData ?? seqFromId;
  const id =
    typeof record.id === "string"
      ? record.id
      : frame.id !== null
        ? frame.id
        : seq !== null
          ? String(seq)
          : null;
  const at =
    typeof record.at === "string" && !Number.isNaN(Date.parse(record.at)) ? record.at : null;
  return { id, seq, at };
}

type Verdict = "duplicate" | "ok" | "gap";

export type Tracker = {
  lastSeq: () => number;
  accept: (event: ParsedEvent) => Verdict;
  coverThrough: (sequence: number) => void;
};

export function createTracker(cap: number): Tracker {
  const seen = new Set<string>();
  const order: string[] = [];
  let lastSeq = 0;
  return {
    lastSeq: () => lastSeq,
    accept(event) {
      if (event.id !== null) {
        if (seen.has(event.id)) {
          return "duplicate";
        }
      }
      if (event.seq === null) {
        rememberId(event.id, seen, order, cap);
        return "ok";
      }
      if (event.seq <= lastSeq) {
        return "duplicate";
      }
      if (event.seq > lastSeq + 1) {
        return "gap";
      }
      lastSeq = event.seq;
      rememberId(event.id, seen, order, cap);
      return "ok";
    },
    coverThrough(sequence) {
      if (Number.isSafeInteger(sequence) && sequence >= 0) {
        lastSeq = Math.max(lastSeq, sequence);
      }
    },
  };
}

function rememberId(id: string | null, seen: Set<string>, order: string[], cap: number): void {
  if (id === null) {
    return;
  }
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
  let uncoveredThrough: number | null = null;

  const handleFrame = (frame: SseFrame): void => {
    const event = parseFrame(frame);
    const verdict = tracker.accept(event);
    if (verdict === "duplicate") {
      return;
    }
    if (verdict === "gap") {
      const required = event.seq;
      if (required === null) {
        return;
      }
      uncoveredThrough = Math.max(uncoveredThrough ?? 0, required);
      cb.patch({ stale: true, asOfSequence: tracker.lastSeq(), lastEventAt: event.at });
      cb.onGap(required).then(
        (watermark) => {
          if (disposed || uncoveredThrough === null) {
            return;
          }
          if (snapshotCoversGap(uncoveredThrough, watermark)) {
            tracker.coverThrough(watermark);
            uncoveredThrough = null;
            cb.patch({ stale: false, asOfSequence: tracker.lastSeq() });
          }
        },
        () => cb.patch({ stale: true }),
      );
      return;
    }
    if (uncoveredThrough !== null && tracker.lastSeq() >= uncoveredThrough) {
      uncoveredThrough = null;
      cb.patch({ stale: false });
    }
    cb.patch({ asOfSequence: tracker.lastSeq(), lastEventAt: event.at });
  };

  const markDown = (): void => {
    cb.patch(
      everConnected
        ? { connection: "reconnecting", detail: "connection lost, retrying" }
        : { connection: "unknown", detail: "events stream unavailable" },
    );
  };

  const loop = async (): Promise<void> => {
    while (!disposed) {
      try {
        await readSseStream(`${apiBase}/v1/events?after=${tracker.lastSeq()}`, controller.signal, {
          onOpen: () => {
            everConnected = true;
            cb.patch({ connection: "live", detail: "" });
          },
          onFrame: handleFrame,
        });
      } catch {
        // fall through to markDown + retry
      }
      if (disposed) {
        return;
      }
      markDown();
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
