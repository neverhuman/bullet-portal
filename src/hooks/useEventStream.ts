import { useEffect, useRef, useState } from "react";
import { apiBase } from "../api";

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

type ParsedEvent = { id: string | null; seq: number | null; at: string };

function parseEvent(raw: MessageEvent): ParsedEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(String(raw.data));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const id =
    typeof record.id === "string" ? record.id : raw.lastEventId !== "" ? raw.lastEventId : null;
  const seq = typeof record.seq === "number" ? record.seq : null;
  const at = typeof record.at === "string" ? record.at : new Date().toISOString();
  return { id, seq, at };
}

type Verdict = "duplicate" | "ok" | "gap";

type Tracker = { lastSeq: () => number | null; accept: (event: ParsedEvent) => Verdict };

function createTracker(cap: number): Tracker {
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

type StreamCallbacks = {
  patch: (next: Partial<EventStreamState>) => void;
  onGap: () => Promise<void>;
};

function createStream(cb: StreamCallbacks): () => void {
  const tracker = createTracker(SEEN_ID_CAP);
  let disposed = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let everConnected = false;

  const handleMessage = (raw: MessageEvent): void => {
    const event = parseEvent(raw);
    if (event === null) {
      return;
    }
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

  const handleError = (): void => {
    if (source !== null && source.readyState === EventSource.CLOSED) {
      cb.patch({ connection: "unknown", detail: "events stream unavailable" });
      retryTimer ??= setTimeout(() => {
        retryTimer = null;
        connect();
      }, RETRY_MS);
      return;
    }
    cb.patch(
      everConnected
        ? { connection: "reconnecting", detail: "connection lost, retrying" }
        : { connection: "unknown", detail: "events stream unavailable" },
    );
  };

  function connect(): void {
    if (disposed) {
      return;
    }
    source = new EventSource(`${apiBase}/v1/events?after=${tracker.lastSeq() ?? 0}`);
    source.onopen = () => {
      everConnected = true;
      cb.patch({ connection: "live", detail: "" });
    };
    source.onmessage = handleMessage;
    source.onerror = handleError;
  }

  connect();
  return () => {
    disposed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
    source?.close();
  };
}

export function useEventStream(onGap: () => Promise<void>): EventStreamState {
  const [state, setState] = useState<EventStreamState>(INITIAL);
  const onGapRef = useRef(onGap);
  onGapRef.current = onGap;

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setState((prev) => ({
        ...prev,
        connection: "unknown",
        detail: "events stream unavailable",
      }));
      return;
    }
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
