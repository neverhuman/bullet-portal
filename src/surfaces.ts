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
  /**
   * Present only while farmd serves no projection for this surface. Names the
   * exact missing durable subject and the V1 slice that will produce it.
   *
   * Profile availability is deliberately not modelled here. Typing a surface
   * as out of a release profile is an availability assertion only farmd can
   * make, from an authenticated installed profile, through a profile-bound
   * availability subject the Portal validates against the generated contract.
   * Until that contract exists every absent ledger subject is `unknownReason`
   * in every view; no browser-side profile selection may change that.
   */
  unknownReason?: string;
};

export const NO_LEDGER_SUBJECT = "no ledger subject exists for this surface yet";

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
    unknownReason:
      `${NO_LEDGER_SUBJECT}: routing decisions and their provenance (task taxonomy, hard ` +
      "exclusions, eligible lanes, quota shadow price, chosen tier, fallback ladder, calibration) " +
      "are not persisted rows; produced by V1-S6 item 1 (persist typed Cognitive Tasks and routing " +
      "provenance) and item 3 (hard-constraint routing)",
  },
  {
    id: "fusion-lab",
    spec: "25.4",
    title: "Fusion Lab",
    answers: "protocol, contributor lanes, disagreements, residual uncertainty, hidden eval",
    unknownReason:
      `${NO_LEDGER_SUBJECT}: fusion protocol runs, contributor lanes, independent artifacts, ` +
      "ranker scores, and fuser provenance are not persisted rows; produced by V1-S6 item 1 " +
      "(persist fusion, dissent, and selection)",
  },
  {
    id: "fleet",
    spec: "25.5",
    title: "Fleet",
    answers: "active lease rows judged against the store clock, linked attempt, ready queue",
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
    answers: "attempt rows by state, fence, workspace, lease held, durable lease events",
  },
  {
    id: "context-lineage",
    spec: "25.8",
    title: "Context Lineage",
    answers: "immutable revision-one capsule subjects, plan/package binding, content digests",
  },
  {
    id: "quota-capacity",
    spec: "25.9",
    title: "Quota and Capacity",
    answers: "Observation of remaining quota — never green UNKNOWN",
    unknownReason:
      `${NO_LEDGER_SUBJECT}: budget/quota reservations and provider capacity observations are ` +
      "not persisted rows; produced by V1-S6 item 1 (persist budget/quota reservations) and item 3 " +
      "(UNKNOWN paid capacity blocks ordinary dispatch)",
  },
  {
    id: "struggle-cockpit",
    spec: "25.10",
    title: "Struggle and Escalation",
    answers: "struggle score, escalation ladder, thrash limit",
    unknownReason:
      `${NO_LEDGER_SUBJECT}: struggle scores, progress signatures, and escalation ladders are ` +
      "not persisted rows; produced by V1-S6 item 1 (persist struggle/escalation)",
  },
  {
    id: "behavior-center",
    spec: "25.11",
    title: "Behavior Center",
    answers: "§17 hits, detector, enforcement, postcondition",
    unknownReason:
      `${NO_LEDGER_SUBJECT}: behavior rule events, enforcement, and remediation receipts are ` +
      "not persisted rows (crates/behavior is a non-authoritative detector scaffold); produced by " +
      "V1-S6 item 1 (persist behavior rules)",
  },
  {
    id: "workspace-hygiene",
    spec: "25.12",
    title: "Workspace and Git Hygiene",
    answers: "clone nonce, preservation receipt, worktree refusal",
    unknownReason:
      `${NO_LEDGER_SUBJECT}: workspace dirty/untracked state, preservation receipts, and ` +
      "cleanup eligibility are not persisted rows (attempt rows carry only workspace_id, " +
      "shown on Session Supervisor); produced by V1-S4 item 2 (preserve the " +
      "workspace, resume from the exact checkpoint) and V1-S3 preservation receipts",
  },
  {
    id: "merge-rail",
    spec: "25.13",
    title: "Merge Rail",
    answers: "exact Candidates, effect intent state machine, append-only receipts",
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
    answers: "durable event tail, outbox phases, sequence, contradictions",
  },
];

export function surfaceById(id: string): Surface | undefined {
  return SURFACES.find((surface) => surface.id === id);
}

/**
 * Whether farmd serves a projection for the surface (`durable`) or the
 * surface names a missing ledger subject (`unknown`). There is no third state.
 */
export type SurfaceStatus = "durable" | "unknown";

export function surfaceStatus(surface: Surface): SurfaceStatus {
  return surface.unknownReason === undefined ? "durable" : "unknown";
}

/** The one-screen Shift Brief route (docs/nightshift.md), reachable from Nav. */
export const SHIFT_BRIEF_ROUTE = "shift-brief";
export const NOT_FOUND_ROUTE = "not-found";

export type RouteId = typeof SHIFT_BRIEF_ROUTE | typeof NOT_FOUND_ROUTE | SurfaceId;

/**
 * Only the root hash opens the Shift Brief by default. Control Tower and all
 * other declared surfaces remain first-class deep links; unknown hashes do
 * not alias an operational view.
 */
export const DEFAULT_ROUTE: RouteId = SHIFT_BRIEF_ROUTE;

export function hashToRoute(hash: string): RouteId {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "") {
    return DEFAULT_ROUTE;
  }
  if (raw === SHIFT_BRIEF_ROUTE) {
    return SHIFT_BRIEF_ROUTE;
  }
  return surfaceById(raw)?.id ?? NOT_FOUND_ROUTE;
}
