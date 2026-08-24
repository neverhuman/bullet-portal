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
  | { kind: "value"; asOf: number; observedAt: string; source: string; body: T }
  | { kind: "unknown"; text: string; observedAt: string; source: "portal/local" };

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
          ...atomicSnapshot([missions, ...graphReads]),
          body: { missions: missions.data, graphs: graphReads.map((read) => read.data) },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          setLoad(localUnknown(`${surface.title}: control plane unreachable (${errorText(err)})`));
        }
      }
    })();
    return () => controller.abort();
  }, [surface.title]);
  return (
    <SurfaceShell surface={surface} load={load}>
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
          ...atomicSnapshot([missions, ready, ...graphReads]),
          body: { ready: ready.data, graphs: graphReads.map((read) => read.data) },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          setLoad(localUnknown(`${surface.title}: control plane unreachable (${errorText(err)})`));
        }
      }
    })();
    return () => controller.abort();
  }, [surface.title]);
  return (
    <SurfaceShell surface={surface} load={load}>
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
        setLoad({ kind: "value", ...atomicSnapshot([outbox]), body: outbox.data });
      } catch (err) {
        if (!controller.signal.aborted) {
          setLoad(localUnknown(`${surface.title}: control plane unreachable (${errorText(err)})`));
        }
      }
    })();
    return () => controller.abort();
  }, [surface.title]);
  return (
    <SurfaceShell surface={surface} load={load}>
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

function SurfaceShell<T>({
  surface,
  load,
  children,
}: {
  surface: Surface;
  load: Load<T>;
  children: ReactNode;
}) {
  const metadata = loadMetadata(load);
  return (
    <section className="card" data-testid={`surface-${surface.id}`}>
      <h1>{surface.title}</h1>
      <p className="tagline">
        spec §{surface.spec} · as_of_sequence {metadata.asOf} · source {metadata.source} · observed_at {metadata.observedAt} · confidence {metadata.confidence}
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

function localUnknown(text: string): Load<never> {
  return {
    kind: "unknown",
    text,
    observedAt: new Date().toISOString(),
    source: "portal/local",
  };
}

function atomicSnapshot(reads: SnapshotRead<unknown>[]): {
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

function loadMetadata<T>(load: Load<T>): {
  asOf: string;
  observedAt: string;
  source: string;
  confidence: "published" | "unknown";
} {
  if (load.kind === "value") {
    return {
      asOf: String(load.asOf),
      observedAt: load.observedAt,
      source: load.source,
      confidence: "published",
    };
  }
  if (load.kind === "unknown") {
    return {
      asOf: "unknown",
      observedAt: load.observedAt,
      source: load.source,
      confidence: "unknown",
    };
  }
  return { asOf: "unknown", observedAt: "unknown", source: "unknown", confidence: "unknown" };
}
