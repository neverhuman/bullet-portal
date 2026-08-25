import { fetchReady, getMission, listMissions, type SnapshotRead } from "../api";
import { ProjectionCard } from "../components/ProjectionCard";
import type { Mission, MissionView, ReadyView } from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";
import { ContextLineagePage } from "./ContextLineagePage";
import { FleetPage } from "./FleetPage";
import { IncidentsAuditPage } from "./IncidentsAuditPage";
import { MergeRailPage } from "./MergeRailPage";
import { QualityLabPage } from "./QualityLabPage";
import { SessionSupervisorPage } from "./SessionSupervisorPage";

/** Surfaces that read farmd JSON. The live stream remains `/api/v1/events`. */
export const PROJECTED_SURFACES = new Set([
  "mission-graph",
  "live-attempt",
  "incidents-audit",
  "fleet",
  "session-supervisor",
  "context-lineage",
  "merge-rail",
  "quality-lab",
]);

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

async function loadGraphs(): Promise<{
  missions: SnapshotRead<Mission[]>;
  graphs: SnapshotRead<MissionView>[];
}> {
  const missions = await listMissions();
  const graphs: SnapshotRead<MissionView>[] = [];
  for (const mission of missions.data) {
    graphs.push(await getMission(mission.id));
  }
  return { missions, graphs };
}

async function loadMissionGraph(): Promise<ProjectionRead<GraphBody>> {
  const { missions, graphs } = await loadGraphs();
  return {
    reads: [missions, ...graphs],
    body: { missions: missions.data, graphs: graphs.map((read) => read.data) },
  };
}

async function loadLiveAttempt(): Promise<ProjectionRead<AttemptBody>> {
  const [{ missions, graphs }, ready] = await Promise.all([loadGraphs(), fetchReady()]);
  return {
    reads: [missions, ready, ...graphs],
    body: { ready: ready.data, graphs: graphs.map((read) => read.data) },
  };
}

export function ProjectedSurface({ surface }: { surface: Surface }) {
  switch (surface.id) {
    case "mission-graph":
      return <MissionGraph surface={surface} />;
    case "live-attempt":
      return <LiveAttempt surface={surface} />;
    case "fleet":
      return <FleetPage surface={surface} />;
    case "session-supervisor":
      return <SessionSupervisorPage surface={surface} />;
    case "context-lineage":
      return <ContextLineagePage surface={surface} />;
    case "merge-rail":
      return <MergeRailPage surface={surface} />;
    case "quality-lab":
      return <QualityLabPage surface={surface} />;
    default:
      return <IncidentsAuditPage surface={surface} />;
  }
}

function MissionGraph({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadMissionGraph);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body) => (
        <pre className="projection" data-testid="mission-graph-projection">
          {JSON.stringify(body, null, 2)}
        </pre>
      )}
    </ProjectionCard>
  );
}

function LiveAttempt({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadLiveAttempt);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body) => (
        <pre className="projection" data-testid="live-attempt-projection">
          {JSON.stringify(body, null, 2)}
        </pre>
      )}
    </ProjectionCard>
  );
}
