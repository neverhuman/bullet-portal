import { useEffect, useState, type ReactNode } from "react";
import {
  errorText,
  fetchOutbox,
  fetchReady,
  getMission,
  listMissions,
  type SnapshotRead,
} from "../api";
import type { Mission, MissionView, OutboxView, ReadyView } from "../generated/api";
import { renderObservation } from "../observation";
import type { Surface } from "../surfaces";

/** Surfaces that read farmd JSON. The live stream remains `/v1/events`. */
export const PROJECTED_SURFACES = new Set(["mission-graph", "live-attempt", "incidents-audit"]);

export function isProjected(id: string): boolean {
  return PROJECTED_SURFACES.has(id);
}

type GraphBody = {
  missions: Mission[];
  graphs: MissionView[];
};

type AttemptBody = {
  ready: ReadyView | null;
  graphs: MissionView[];
};

type Load<T> =
  | { kind: "loading" }
  | { kind: "value"; asOf: number | null; body: T }
  | { kind: "unknown"; text: string };

export function ProjectedSurface({ surface }: { surface: Surface }) {
  if (surface.id === "mission-graph") {
    return <MissionGraph surface={surface} />;
  }
  if (surface.id === "live-attempt") {
    return <LiveAttempt surface={surface} />;
  }
  return <IncidentsAudit surface={surface} />;
}

function MissionGraph({ surface }: { surface: Surface }) {
  const [load, setLoad] = useState<Load<GraphBody>>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const missions = await listMissions();
        const graphReads: SnapshotRead<MissionView>[] = [];
        for (const mission of missions.data) {
          graphReads.push(await getMission(mission.id));
        }
        if (controller.signal.aborted) {
          return;
        }
        setLoad({
          kind: "value",
          asOf: atomicSequence([missions, ...graphReads]),
          body: { missions: missions.data, graphs: graphReads.map((read) => read.data) },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          setLoad({
            kind: "unknown",
            text: `${surface.title}: control plane unreachable (${errorText(err)})`,
          });
        }
      }
    })();
    return () => controller.abort();
  }, [surface.title]);
  return (
    <SurfaceShell surface={surface} asOf={asOfOf(load)}>
      {load.kind === "loading" ? (
        <p data-testid="mission-graph-loading">loading projection</p>
      ) : load.kind === "unknown" ? (
        <Unknown id="mission-graph" text={load.text} />
      ) : (
        <pre className="projection" data-testid="mission-graph-projection">
          {JSON.stringify(load.body, null, 2)}
        </pre>
      )}
    </SurfaceShell>
  );
}

function LiveAttempt({ surface }: { surface: Surface }) {
  const [load, setLoad] = useState<Load<AttemptBody>>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [missions, ready] = await Promise.all([listMissions(), fetchReady()]);
        const graphReads: SnapshotRead<MissionView>[] = [];
        for (const mission of missions.data) {
          graphReads.push(await getMission(mission.id));
        }
        if (controller.signal.aborted) {
          return;
        }
        setLoad({
          kind: "value",
          asOf: atomicSequence([missions, ready, ...graphReads]),
          body: { ready: ready.data, graphs: graphReads.map((read) => read.data) },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          setLoad({
            kind: "unknown",
            text: `${surface.title}: control plane unreachable (${errorText(err)})`,
          });
        }
      }
    })();
    return () => controller.abort();
  }, [surface.title]);
  return (
    <SurfaceShell surface={surface} asOf={asOfOf(load)}>
      {load.kind === "loading" ? (
        <p data-testid="live-attempt-loading">loading projection</p>
      ) : load.kind === "unknown" ? (
        <Unknown id="live-attempt" text={load.text} />
      ) : (
        <pre className="projection" data-testid="live-attempt-projection">
          {JSON.stringify(load.body, null, 2)}
        </pre>
      )}
    </SurfaceShell>
  );
}

function IncidentsAudit({ surface }: { surface: Surface }) {
  const [load, setLoad] = useState<Load<OutboxView>>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const outbox = await fetchOutbox();
        if (controller.signal.aborted) {
          return;
        }
        setLoad({ kind: "value", asOf: outbox.asOfSequence, body: outbox.data });
      } catch (err) {
        if (!controller.signal.aborted) {
          setLoad({
            kind: "unknown",
            text: `${surface.title}: control plane unreachable (${errorText(err)})`,
          });
        }
      }
    })();
    return () => controller.abort();
  }, [surface.title]);
  return (
    <SurfaceShell surface={surface} asOf={asOfOf(load)}>
      {load.kind === "loading" ? (
        <p data-testid="incidents-audit-loading">loading projection</p>
      ) : load.kind === "unknown" ? (
        <Unknown id="incidents-audit" text={load.text} />
      ) : (
        <pre className="projection" data-testid="incidents-audit-projection">
          {JSON.stringify(load.body, null, 2)}
        </pre>
      )}
    </SurfaceShell>
  );
}

function SurfaceShell({
  surface,
  asOf,
  children,
}: {
  surface: Surface;
  asOf: string;
  children: ReactNode;
}) {
  return (
    <section className="card" data-testid={`surface-${surface.id}`}>
      <h1>{surface.title}</h1>
      <p className="tagline">
        spec §{surface.spec} · as_of_sequence {asOf} · confidence published
      </p>
      <p>Answers: {surface.answers}</p>
      {children}
    </section>
  );
}

function Unknown({ id, text }: { id: string; text: string }) {
  return (
    <p className="unknown" data-testid={`${id}-unknown`}>
      {renderObservation({ kind: "unknown", text })}
    </p>
  );
}

function asOfOf<T>(load: Load<T>): string {
  return load.kind === "value" && load.asOf !== null ? String(load.asOf) : "unknown";
}

function atomicSequence(reads: SnapshotRead<unknown>[]): number {
  const first = reads[0]?.asOfSequence;
  if (first === null || first === undefined) {
    throw new Error("SNAPSHOT_WATERMARK_MISSING");
  }
  if (reads.some((read) => read.asOfSequence !== first)) {
    throw new Error("SNAPSHOT_WATERMARK_MISMATCH");
  }
  return first;
}
