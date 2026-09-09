import { useEffect, useState } from "react";
import { errorText, type SnapshotRead } from "../api";

/** One surface's read: a set of snapshot reads and the body derived from them. */
export type ProjectionRead<T> = { reads: SnapshotRead<unknown>[]; body: T };

export type ProjectionLoad<T> =
  | { kind: "loading" }
  | { kind: "value"; asOf: number; observedAt: string; source: string; body: T }
  | { kind: "unknown"; text: string; observedAt: string; source: "portal/local" };

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
 * Load one surface exactly once per mount. `load` must be a stable function
 * (module level) so the effect does not re-run on every render.
 */
export function useProjection<T>(
  title: string,
  load: () => Promise<ProjectionRead<T>>,
): ProjectionLoad<T> {
  const [state, setState] = useState<ProjectionLoad<T>>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { reads, body } = await load();
        if (controller.signal.aborted) {
          return;
        }
        setState({ kind: "value", ...atomicSnapshot(reads), body });
      } catch (err) {
        if (!controller.signal.aborted) {
          setState(localUnknown(`${title}: control plane unreachable (${errorText(err)})`));
        }
      }
    })();
    return () => controller.abort();
  }, [title, load]);
  return state;
}
