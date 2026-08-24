export type SurfaceId =
  | "control-tower"
  | "mission-graph"
  | "cognitive-router"
  | "fusion-lab"
  | "fleet"
  | "live-attempt"
  | "session-supervisor"
  | "context-lineage"
  | "quota-capacity"
  | "struggle-cockpit"
  | "behavior-center"
  | "workspace-hygiene"
  | "merge-rail"
  | "quality-lab"
  | "incidents-audit";

export type Surface = {
  id: SurfaceId;
  spec: string;
  title: string;
  answers: string;
};

export const SURFACES: Surface[] = [
  {
    id: "control-tower",
    spec: "25.1",
    title: "Control Tower",
    answers: "verified work, survival, cost, quota risk, struggle, control-plane health",
  },
  {
    id: "mission-graph",
    spec: "25.2",
    title: "Mission Graph",
    answers: "plan revisions, packages, variants, attempts, candidates, evidence, effects",
  },
  {
    id: "cognitive-router",
    spec: "25.3",
    title: "Cognitive Router",
    answers: "taxonomy, eligible lanes, quota shadow price, chosen tier, shadow outcomes",
  },
  {
    id: "fusion-lab",
    spec: "25.4",
    title: "Fusion Lab",
    answers: "protocol, contributor lanes, disagreements, residual uncertainty, hidden eval",
  },
  {
    id: "fleet",
    spec: "25.5",
    title: "Fleet",
    answers: "provider, runner, lease, quota reservation, process state",
  },
  {
    id: "live-attempt",
    spec: "25.6",
    title: "Live Attempt",
    answers: "session events, fence, authority token hash, last progress",
  },
  {
    id: "session-supervisor",
    spec: "25.7",
    title: "Session Supervisor",
    answers: "process tree, interrupt, freeze, salvage",
  },
  {
    id: "context-lineage",
    spec: "25.8",
    title: "Context Lineage",
    answers: "capsule as-of, compression, dropped decisions",
  },
  {
    id: "quota-capacity",
    spec: "25.9",
    title: "Quota and Capacity",
    answers: "Observation of remaining quota — never green UNKNOWN",
  },
  {
    id: "struggle-cockpit",
    spec: "25.10",
    title: "Struggle and Escalation",
    answers: "struggle score, escalation ladder, thrash limit",
  },
  {
    id: "behavior-center",
    spec: "25.11",
    title: "Behavior Center",
    answers: "§17 hits, detector, enforcement, postcondition",
  },
  {
    id: "workspace-hygiene",
    spec: "25.12",
    title: "Workspace and Git Hygiene",
    answers: "clone nonce, preservation receipt, worktree refusal",
  },
  {
    id: "merge-rail",
    spec: "25.13",
    title: "Merge Rail",
    answers: "pinned Candidate, expected-old-OID, integration dwell",
  },
  {
    id: "quality-lab",
    spec: "25.14",
    title: "Quality Lab",
    answers: "GateOutcome histogram — flaky/infra/unknown never read as PASS",
  },
  {
    id: "incidents-audit",
    spec: "25.15",
    title: "Incidents and Audit",
    answers: "event log, sequence, lag, contradictions",
  },
];

export function surfaceById(id: string): Surface | undefined {
  return SURFACES.find((surface) => surface.id === id);
}

export function hashToSurface(hash: string): SurfaceId {
  const raw = hash.replace(/^#\/?/, "");
  return surfaceById(raw)?.id ?? "control-tower";
}
