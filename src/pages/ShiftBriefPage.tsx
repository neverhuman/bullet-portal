import { operatorSnapshotStale, useOperatorSnapshot } from "../hooks/useOperatorSnapshot";
import { SURFACES, surfaceStatus, type Surface } from "../surfaces";

/** Provenance shared by all durable rows in one operator snapshot. */
export type Provenance =
  | { kind: "loading" }
  | { kind: "value"; asOf: number; observedAt: string; source: string; stale?: boolean }
  | { kind: "unknown"; text: string };

/**
 * Evidence classes the brief can name. Only `PROJECTION_SNAPSHOT` is backed by
 * a ledger read at an exact sequence; every `NONE_*` class is a typed absence
 * and never a passing state.
 */
export type EvidenceClass =
  | "PROJECTION_SNAPSHOT"
  | "NONE_LOADING"
  | "NONE_UNREACHABLE"
  | "NONE_NO_SUBJECT";

/**
 * A surface is either durable (farmd projects it) or unknown (it names a
 * missing ledger subject). Profile availability is not a Portal-side state:
 * only a farmd-served, validated availability subject could add one.
 */
export type BriefStatus = "durable" | "unknown";

export type BriefRow = {
  surface: Surface;
  status: BriefStatus;
  /** Neutral or warning style for the status cell; never `verified`. */
  statusClass: "idle" | "unknown";
  claim: string;
  subject: string;
  evidence: EvidenceClass;
  freshness: string;
  blocker: string;
  nextAction: string;
};

const NO_PORTAL_ACTION =
  "none authorized in the Portal: the producing Kernel slice must persist the subject; the Portal cannot mint it";

function durableRow(surface: Surface, provenance: Provenance): BriefRow {
  const claim = `${surface.title} answers "${surface.answers}" from the ledger`;
  if (provenance.kind === "value") {
    return {
      surface,
      status: "durable",
      statusClass: "idle",
      claim: `${claim} at as_of_sequence ${provenance.asOf}`,
      subject: `${provenance.source} · as_of_sequence ${provenance.asOf}`,
      evidence: "PROJECTION_SNAPSHOT",
      freshness: `observed_at ${provenance.observedAt} (event refresh; 10s fallback)${provenance.stale ? " · STALE" : ""}`,
      blocker: provenance.stale ? "snapshot may lag the event cursor; refresh before acting" : "none at this sequence",
      nextAction: `open #/${surface.id} and read it at as_of_sequence ${provenance.asOf}; re-read before acting on anything newer`,
    };
  }
  if (provenance.kind === "loading") {
    return {
      surface,
      status: "durable",
      statusClass: "idle",
      claim: `${claim} (unproved: read in flight)`,
      subject: "unknown (read in flight)",
      evidence: "NONE_LOADING",
      freshness: "unknown",
      blocker: "snapshot read has not returned",
      nextAction: "wait for the read; no claim is proved until it returns",
    };
  }
  return {
    surface,
    status: "durable",
    statusClass: "unknown",
    claim: `${claim} (unproved: read failed)`,
    subject: "unknown (read failed)",
    evidence: "NONE_UNREACHABLE",
    freshness: "unknown",
    blocker: `unknown: ${provenance.text}`,
    nextAction: "restore same-origin farmd reachability, then re-read; no Portal action substitutes for the read",
  };
}

export function briefRow(surface: Surface, provenance: Provenance): BriefRow {
  if (surfaceStatus(surface) === "durable") {
    return durableRow(surface, provenance);
  }
  return {
    surface,
    status: "unknown",
    statusClass: "unknown",
    claim: `${surface.title} answers "${surface.answers}" (unproved: no ledger subject)`,
    subject: "none (no ledger subject)",
    evidence: "NONE_NO_SUBJECT",
    freshness: "unknown",
    blocker: `unknown: ${surface.unknownReason ?? "control plane has not published this projection"}`,
    nextAction: NO_PORTAL_ACTION,
  };
}

function summarize(rows: BriefRow[]): string {
  const count = (predicate: (row: BriefRow) => boolean): number => rows.filter(predicate).length;
  const durable = count((row) => row.status === "durable");
  const proved = count((row) => row.evidence === "PROJECTION_SNAPSHOT");
  return (
    `${rows.length} surfaces · durable ${durable} (read at a sequence ${proved}, read unknown ${durable - proved}) · ` +
    `unknown ${count((row) => row.status === "unknown")} · profile availability unknown`
  );
}

const COLUMNS: ReadonlyArray<[string, (row: BriefRow) => string]> = [
  ["claim", (row) => row.claim],
  ["subject", (row) => row.subject],
  ["evidence class", (row) => row.evidence],
  ["freshness", (row) => row.freshness],
  ["blocker", (row) => row.blocker],
  ["next authorized action", (row) => row.nextAction],
];

/** Per-surface obligations projected from one authenticated ledger transaction. */
export function ShiftBriefPage() {
  const snapshot = useOperatorSnapshot();
  const stale = operatorSnapshotStale(snapshot);
  const provenance: Provenance = snapshot.kind === "value"
    ? { ...snapshot, stale }
    : snapshot;
  const rows = SURFACES.map((surface) => briefRow(surface, provenance));
  return (
    <section className="card" data-testid="shift-brief">
      <h1 id="shift-brief-title">Shift Brief</h1>
      <p className="tagline" data-testid="shift-brief-tagline">
        profile availability unknown (farmd serves no selected-profile subject, so every absent
        ledger subject is unknown under every profile) · rows from the Portal surface declarations
        plus one atomic operator snapshot · event refresh; 10s fallback
      </p>
      <div className="statusline" data-testid="shift-brief-snapshot">
        <span className={snapshot.kind === "unknown" ? "unknown" : stale ? "stale" : "idle"}>
          {snapshot.kind === "value" ? (stale ? "STALE" : "Snapshot current through event cursor") : `Snapshot ${snapshot.kind}`}
        </span>
        <span>snapshot {snapshot.kind === "value" ? snapshot.asOf : "unknown"}</span>
        <span>events {snapshot.stream?.connection ?? "unknown"} · cursor {snapshot.stream?.asOfSequence ?? "unknown"}</span>
        <button type="button" onClick={snapshot.refresh}>Refresh snapshot</button>
      </div>
      <p className="unknown" data-testid="shift-brief-decision">
        RELEASE DECISION: unknown — no release-truth subject is projected to the Portal; the Portal
        mints no authority
      </p>
      <p className="idle" data-testid="shift-brief-summary">
        {summarize(rows)}
      </p>
      <div
        className="table-scroll"
        role="region"
        aria-labelledby="shift-brief-title"
        tabIndex={0}
        data-testid="shift-brief-table-region"
      >
        <table data-testid="shift-brief-rows">
          <thead>
            <tr>
              <th>surface</th>
              <th>status</th>
              {COLUMNS.map(([header]) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.surface.id} data-testid={`brief-row-${row.surface.id}`}>
                <td>
                  <a href={`#/${row.surface.id}`}>{row.surface.title}</a> §{row.surface.spec}
                </td>
                <td className={row.statusClass} data-testid={`brief-${row.surface.id}-status`}>
                  {row.status}
                </td>
                {COLUMNS.map(([header, cell]) => (
                  <td key={header} data-testid={`brief-${row.surface.id}-${header.split(" ")[0]}`}>
                    {cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
