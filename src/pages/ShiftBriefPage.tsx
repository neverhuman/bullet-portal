import { useEffect, useState } from "react";
import {
  errorText,
  fetchAudit,
  fetchContextLineage,
  fetchFleet,
  fetchMergeRail,
  fetchQualityLab,
  fetchReady,
  fetchSessions,
  listMissions,
  type SnapshotRead,
} from "../api";
import { SURFACES, surfaceStatus, type Surface, type SurfaceId } from "../surfaces";

/**
 * Provenance of one durable surface: the same snapshot read its own page
 * performs, reduced to the envelope. Nothing here is a new endpoint.
 */
export type Provenance =
  | { kind: "loading" }
  | { kind: "value"; asOf: number; observedAt: string; source: string }
  | { kind: "unknown"; text: string };

export type ProvenanceMap = Partial<Record<SurfaceId, Provenance>>;

type ProvenanceRead = () => Promise<SnapshotRead<unknown>>;

/**
 * Durable surfaces and the read that carries their watermark. Control Tower
 * and Mission Graph share the missions list, which is read exactly once.
 */
const DURABLE_READS: ReadonlyArray<[SurfaceId, (missions: ProvenanceRead) => Promise<SnapshotRead<unknown>>]> = [
  ["control-tower", (missions) => missions()],
  ["mission-graph", (missions) => missions()],
  ["live-attempt", () => fetchReady()],
  ["fleet", () => fetchFleet()],
  ["session-supervisor", () => fetchSessions()],
  ["context-lineage", () => fetchContextLineage()],
  ["merge-rail", () => fetchMergeRail()],
  ["quality-lab", () => fetchQualityLab()],
  ["incidents-audit", () => fetchAudit()],
];

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
      freshness: `observed_at ${provenance.observedAt} (one-shot snapshot, not live)`,
      blocker: "none at this sequence",
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

/** Read every durable surface's provenance once per mount, independently per row. */
export function useProvenance(): ProvenanceMap {
  const [reads, setReads] = useState<ProvenanceMap>({});
  useEffect(() => {
    let active = true;
    let shared: Promise<SnapshotRead<unknown>> | undefined;
    const missions: ProvenanceRead = () => (shared ??= listMissions());
    for (const [id, read] of DURABLE_READS) {
      void read(missions)
        .then((snapshot): Provenance => ({
          kind: "value",
          asOf: snapshot.asOfSequence,
          observedAt: snapshot.observedAt,
          source: snapshot.source,
        }))
        .catch((err: unknown): Provenance => ({ kind: "unknown", text: errorText(err) }))
        .then((provenance) => {
          if (active) {
            setReads((current) => ({ ...current, [id]: provenance }));
          }
        });
    }
    return () => {
      active = false;
    };
  }, []);
  return reads;
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

/**
 * One screen naming, per surface, the exact claim that remains unproved
 * (docs/nightshift.md). Rows come only from the static surface declarations
 * and each durable surface's own snapshot read; nothing is fetched that a
 * surface page does not already fetch, no value is ever rendered as verified,
 * and no browser-side profile choice exists: profile availability is unknown
 * until farmd serves a validated availability subject.
 */
export function ShiftBriefPage() {
  const reads = useProvenance();
  const rows = SURFACES.map((surface) => briefRow(surface, reads[surface.id] ?? { kind: "loading" }));
  return (
    <section className="card" data-testid="shift-brief">
      <h1 id="shift-brief-title">Shift Brief</h1>
      <p className="tagline" data-testid="shift-brief-tagline">
        profile availability unknown (farmd serves no selected-profile subject, so every absent
        ledger subject is unknown under every profile) · rows from the Portal surface declarations
        plus each durable surface&apos;s own snapshot read · one-shot snapshots, not live
      </p>
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
