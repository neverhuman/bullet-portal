import { useEffect, useState } from "react";
import type { EventStreamState, StreamConnection } from "../hooks/useEventStream";
import { operatorSnapshotStale } from "../hooks/useOperatorSnapshot";
import type { ProjectionLoad } from "../hooks/useProjection";
import type { Loadable } from "../loadable";
import { renderObservation } from "../observation";

const CONNECTION_CLASS: Record<StreamConnection, string> = {
  live: "live",
  reconnecting: "reconnecting",
  unknown: "unknown",
};

function formatLag(lastEventAt: string | null, nowMs: number): string {
  if (lastEventAt === null) {
    return "unknown (no events received)";
  }
  const eventMs = Date.parse(lastEventAt);
  if (Number.isNaN(eventMs)) {
    return "unknown (unparseable event time)";
  }
  return `${Math.max(0, Math.round((nowMs - eventMs) / 1000))}s`;
}

export function StatusHeader({
  stream,
  health,
  snapshot,
}: {
  stream: EventStreamState;
  health: Loadable<string>;
  snapshot?: ProjectionLoad<unknown>;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (stream.lastEventAt === null) {
      return;
    }
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stream.lastEventAt]);

  const sequence = snapshot === undefined ? stream.asOfSequence : snapshot.kind === "value" ? snapshot.asOf : null;
  const stale = snapshot === undefined ? stream.stale : operatorSnapshotStale(snapshot);
  return (
    <section className="statusline" data-testid="status-header">
      <span data-testid="as-of-sequence">as_of_sequence: {sequence ?? "unknown"}</span>
      <span data-testid="event-cursor">event cursor: {stream.asOfSequence ?? "unknown"}</span>
      <span data-testid="event-continuity">event continuity: {stream.stale ? "unresolved" : "no known gap"}</span>
      <span data-testid="projection-lag">
        projection lag: {formatLag(stream.lastEventAt, nowMs)}
      </span>
      <span className={CONNECTION_CLASS[stream.connection]} data-testid="stream-connection">
        events: {stream.connection}
        {stream.detail !== "" ? ` (${stream.detail})` : ""}
      </span>
      {stale ? (
        <span className="stale" data-testid="stale-badge">
          STALE
        </span>
      ) : null}
      <HealthLine health={health} />
    </section>
  );
}

function HealthLine({ health }: { health: Loadable<string> }) {
  if (health.kind === "loading") {
    return (
      <span className="idle" data-testid="health-probe">
        farmd /health: checking
      </span>
    );
  }
  if (health.kind === "unknown") {
    return (
      <span className="unknown" data-testid="health-probe">
        farmd /health: {renderObservation({ kind: "unknown", text: health.reason })} (observed{" "}
        {health.observedAt})
      </span>
    );
  }
  return (
    <span className={health.value === "ok" ? "idle" : "pending"} data-testid="health-probe">
      farmd /health: {renderObservation({ kind: "value", text: health.value })} (observed{" "}
      {health.observedAt})
    </span>
  );
}
