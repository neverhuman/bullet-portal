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

export type ParsedEvent = { id: string | null; seq: number | null; at: string };

/**
 * Kernel framing: SSE id = ledger seq, SSE event = kind, data = Event JSON
 * ({seq, kind, body, event_id, ...}; no timestamp, so `at` is arrival time).
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
  const seqFromData = typeof record.seq === "number" ? record.seq : null;
  const seqFromId = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
  const seq = seqFromData ?? seqFromId;
  const id =
    typeof record.event_id === "string"
      ? record.event_id
      : frame.id !== null
        ? frame.id
        : seq !== null
          ? String(seq)
          : null;
  return { id, seq, at: new Date().toISOString() };
}

type Verdict = "duplicate" | "ok" | "gap";

export type Tracker = { lastSeq: () => number | null; accept: (event: ParsedEvent) => Verdict };

export function createTracker(cap: number): Tracker {
  const seen = new Set<string>();
  const order: string[] = [];
  let lastSeq: number | null = null;
  return {
    lastSeq: () => lastSeq,
    accept(event) {
      if (event.id !== null) {
        if (seen.has(event.id)) {
          return "duplicate";
        }
        seen.add(event.id);
        order.push(event.id);
        if (order.length > cap) {
          const oldest = order.shift();
          if (oldest !== undefined) {
            seen.delete(oldest);
          }
        }
      }
      if (event.seq === null) {
        return "ok";
      }
      if (lastSeq !== null && event.seq <= lastSeq) {
        return "duplicate";
      }
      const jumped = lastSeq !== null && event.seq > lastSeq + 1;
      lastSeq = event.seq;
      return jumped ? "gap" : "ok";
    },
  };
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
  onGap: () => Promise<void>;
};

function createStream(cb: StreamCallbacks): () => void {
  const tracker = createTracker(SEEN_ID_CAP);
  const controller = new AbortController();
  let disposed = false;
  let everConnected = false;

  const handleFrame = (frame: SseFrame): void => {
    const event = parseFrame(frame);
    const verdict = tracker.accept(event);
    if (verdict === "duplicate") {
      return;
    }
    if (verdict === "gap") {
      cb.patch({ stale: true });
      cb.onGap().then(
        () => cb.patch({ stale: false }),
        () => cb.patch({ stale: true }),
      );
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
        await readSseStream(`${apiBase}/v1/events?after=${tracker.lastSeq() ?? 0}`, controller.signal, {
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

export function useEventStream(onGap: () => Promise<void>): EventStreamState {
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
      onGap: () => onGapRef.current(),
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  return state;
}
