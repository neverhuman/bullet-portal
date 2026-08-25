import { useEffect, useRef, useState } from "react";
import { apiBase } from "../api";
import { isEventEnvelope } from "../apiValidation";
import { API_PREFIX } from "../generated/api";
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

function safeFrameSequence(frame: SseFrame): number | null {
  if (frame.id === null || !/^\d+$/.test(frame.id)) {
    return null;
  }
  const sequence = Number(frame.id);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

/**
 * Kernel framing: SSE id = ledger seq and default-message data = EventEnvelope.
 */
export function parseFrame(frame: SseFrame): ParsedEvent | null {
  const frameSequence = safeFrameSequence(frame);
  if (frame.event !== "message" || frameSequence === null) {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(frame.data) as unknown;
  } catch {
    return null;
  }
  if (
    !isEventEnvelope(record) ||
    record.seq !== frameSequence
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
  markUncertain: (observedThrough?: number) => void;
  applySnapshot: (watermark: number | null) => boolean;
};

export function createTracker(cap: number): Tracker {
  const seenIds = new Map<string, number>();
  const seenSequences = new Map<number, string>();
  const order: ParsedEvent[] = [];
  let lastSeq = 0;
  let requiredThrough: number | null = null;
  const requireThrough = (sequence: number): void => {
    requiredThrough = Math.max(requiredThrough ?? 0, sequence);
  };
  return {
    lastSeq: () => lastSeq,
    stale: () => requiredThrough !== null,
    requiredThrough: () => requiredThrough,
    accept(event) {
      const knownSequence = seenIds.get(event.id);
      const knownId = seenSequences.get(event.seq);
      if (knownSequence !== undefined || knownId !== undefined) {
        if (knownSequence === event.seq && knownId === event.id) {
          return "duplicate";
        }
        requireThrough(Math.max(lastSeq + 1, event.seq));
        return "gap";
      }
      if (event.seq <= lastSeq) {
        requireThrough(lastSeq + 1);
        return "gap";
      }
      if (event.seq > lastSeq + 1) {
        requireThrough(event.seq);
        return "gap";
      }
      lastSeq = event.seq;
      rememberEvent(event, seenIds, seenSequences, order, cap);
      if (requiredThrough !== null && lastSeq >= requiredThrough) {
        requiredThrough = null;
      }
      return "ok";
    },
    markUncertain(observedThrough) {
      requireThrough(Math.max(lastSeq + 1, observedThrough ?? 0));
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

function rememberEvent(
  event: ParsedEvent,
  seenIds: Map<string, number>,
  seenSequences: Map<number, string>,
  order: ParsedEvent[],
  cap: number,
): void {
  seenIds.set(event.id, event.seq);
  seenSequences.set(event.seq, event.id);
  order.push(event);
  if (order.length > cap) {
    const oldest = order.shift();
    if (oldest !== undefined) {
      seenIds.delete(oldest.id);
      seenSequences.delete(oldest.seq);
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
  let activeConnection: AbortController | null = null;
  let rebaseRequested = false;

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
          const connection = activeConnection;
          if (connection !== null && !connection.signal.aborted) {
            rebaseRequested = true;
            cb.patch({
              connection: "reconnecting",
              detail: "snapshot reconciled, reconnecting",
            });
            connection.abort(new Error("snapshot recovery rebased event stream"));
          }
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
      tracker.markUncertain(safeFrameSequence(frame) ?? undefined);
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
          ? `${apiBase}${API_PREFIX}/events`
          : `${apiBase}${API_PREFIX}/events?after=${cursor}`;
        const connection = new AbortController();
        activeConnection = connection;
        try {
          await readSseStream(
            url,
            connection.signal,
            {
              onOpen: () => {
                everConnected = true;
                cb.patch({ connection: "live", detail: "" });
              },
              onFrame: handleFrame,
            },
            reconnect ? cursor : undefined,
          );
        } finally {
          if (activeConnection === connection) {
            activeConnection = null;
          }
        }
      } catch {
        // fall through to markDown + retry
      }
      if (disposed) {
        return;
      }
      if (rebaseRequested) {
        rebaseRequested = false;
        reconnect = true;
        continue;
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
    activeConnection?.abort();
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
