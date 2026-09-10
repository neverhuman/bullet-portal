import { fetchOperatorSnapshot } from "../api";
import type { OperatorSnapshotView } from "../generated/api";
import type { Loadable } from "../loadable";
import { useProjection, type ProjectionLoad } from "./useProjection";

async function loadOperatorSnapshot() {
  const snapshot = await fetchOperatorSnapshot();
  return { reads: [snapshot], body: snapshot.data };
}

export function useOperatorSnapshot() {
  return useProjection("Operator snapshot", loadOperatorSnapshot);
}

export function operatorPart<K extends keyof OperatorSnapshotView>(
  load: ProjectionLoad<OperatorSnapshotView>, key: K,
): Loadable<OperatorSnapshotView[K]> {
  if (load.kind === "loading") return { kind: "loading" };
  if (load.kind === "unknown") {
    return { kind: "unknown", reason: load.text, observedAt: load.observedAt, source: load.source };
  }
  return { kind: "value", value: load.body[key], observedAt: load.observedAt, source: load.source };
}

export function operatorSnapshotStale(load: ProjectionLoad<unknown>): boolean {
  const stream = load.stream;
  return stream !== undefined && (stream.stale || stream.connection !== "live" ||
    (load.kind === "value" && stream.asOfSequence !== null && load.asOf < stream.asOfSequence));
}
