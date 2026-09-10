import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, type SnapshotRead } from "../api";
import { useEventStream, type EventStreamState } from "./useEventStream";
import { browserSessionEpoch, onBrowserSessionChange } from "../apiSession";

/** One surface's read: a set of snapshot reads and the body derived from them. */
export type ProjectionRead<T> = { reads: SnapshotRead<unknown>[]; body: T };

export type ProjectionLoad<T> = (
  | { kind: "loading" }
  | { kind: "value"; asOf: number; observedAt: string; source: string; body: T }
  | { kind: "unknown"; text: string; observedAt: string; source: "portal/local" }
) & { stream?: EventStreamState; refresh?: () => void };

export function localUnknown(text: string): ProjectionLoad<never> {
  return {
    kind: "unknown",
    text,
    observedAt: new Date().toISOString(),
    source: "portal/local",
  };
}

/**
 * Combine several snapshot reads into one as-of. Reads from different
 * sequences or sources are a contradiction, never a merged picture.
 */
export function atomicSnapshot(reads: SnapshotRead<unknown>[]): {
  asOf: number;
  observedAt: string;
  source: string;
} {
  const first = reads[0];
  if (first === undefined) {
    throw new Error("SNAPSHOT_WATERMARK_MISSING");
  }
  if (reads.some((read) => read.asOfSequence !== first.asOfSequence)) {
    throw new Error("SNAPSHOT_WATERMARK_MISMATCH");
  }
  if (reads.some((read) => read.source !== first.source)) {
    throw new Error("SNAPSHOT_SOURCE_MISMATCH");
  }
  const latest = reads.reduce((current, read) =>
    Date.parse(read.observedAt) > Date.parse(current.observedAt) ? read : current,
  );
  return {
    asOf: first.asOfSequence,
    observedAt: latest.observedAt,
    source: first.source,
  };
}

/**
 * One active surface owns one stream. Events invalidate its atomic snapshot;
 * the event cursor never substitutes for the displayed snapshot's watermark.
 * `load` must be stable (module level). The transport bounds pending reads.
 */
export function useProjection<T>(
  title: string,
  load: () => Promise<ProjectionRead<T>>,
): ProjectionLoad<T> {
  const [state, setState] = useState<ProjectionLoad<T>>({ kind: "loading" });
  const requestRef = useRef<((sequence: number) => Promise<number | null>) | null>(null);
  const refreshRef = useRef<(() => Promise<number | null>) | null>(null);
  const invalidateRef = useRef<((sequence: number) => void) | null>(null);
  const [epoch, setEpoch] = useState(browserSessionEpoch);
  useEffect(() => onBrowserSessionChange(() => {
    setState({ kind: "loading" });
    setEpoch(browserSessionEpoch());
  }), []);
  useEffect(() => {
    let disposed = false;
    let inFlight: Promise<number | null> | null = null;
    let requested = 0;
    let published = -1;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: "loading" });

    const invalidate = (sequence: number) => {
      requested = Math.max(requested, sequence);
      if (scheduled === undefined && !disposed) {
        scheduled = setTimeout(() => {
          scheduled = undefined;
          void request(requested);
        }, 100);
      }
    };
    const request = (sequence: number): Promise<number | null> => {
      if (disposed) return Promise.resolve(null);
      requested = Math.max(requested, sequence);
      if (inFlight !== null) return inFlight;
      clearTimeout(scheduled);
      scheduled = undefined;
      const startedThrough = requested;
      inFlight = (async () => {
        try {
          const { reads, body } = await load();
          if (disposed || epoch !== browserSessionEpoch()) return null;
          const snapshot = atomicSnapshot(reads);
          if (snapshot.asOf < published) throw new Error("SNAPSHOT_SEQUENCE_REGRESSION");
          published = snapshot.asOf;
          setState({ kind: "value", ...snapshot, body });
          return snapshot.asOf;
        } catch (err) {
          if (!disposed && epoch === browserSessionEpoch()) setState(localUnknown(`${title}: control plane unreachable (${errorText(err)})`));
          return null;
        }
      })().finally(() => {
        inFlight = null;
        // A burst during a slow read gets one successor read, not an unbounded queue.
        if (requested > startedThrough && published < requested) invalidate(requested);
      });
      return inFlight;
    };
    requestRef.current = (sequence) => inFlight === null && published >= sequence
      ? Promise.resolve(published) : request(sequence);
    refreshRef.current = () => request(0);
    invalidateRef.current = invalidate;
    void request(0);
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden") void request(requested);
    };
    const interval = setInterval(refreshVisible, 10_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      disposed = true;
      clearTimeout(scheduled);
      clearInterval(interval);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [title, load, epoch]);
  const reconcile = useCallback((sequence: number) => requestRef.current?.(sequence) ?? Promise.resolve(null), []);
  const onEvent = useCallback((sequence: number) => invalidateRef.current?.(sequence), []);
  const refresh = useCallback(() => { void refreshRef.current?.(); }, []);
  const stream = useEventStream(reconcile, onEvent, state.kind === "value" ? state.asOf : undefined);
  return { ...state, stream, refresh };
}
