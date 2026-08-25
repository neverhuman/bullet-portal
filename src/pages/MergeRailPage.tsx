import { fetchMergeRail } from "../api";
import { nullable, ProjectionCard, RowsTable, type Column } from "../components/ProjectionCard";
import type {
  CandidateRow,
  EffectIntentRow,
  EffectReceiptRow,
  EffectRow,
  MergeRailView,
} from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";
import { COUNT_COLUMNS } from "./SessionSupervisorPage";

async function loadMergeRail(): Promise<ProjectionRead<MergeRailView>> {
  const rail = await fetchMergeRail();
  return { reads: [rail], body: rail.data };
}

const CANDIDATE_COLUMNS: Column<CandidateRow>[] = [
  { header: "candidate", cell: (row) => row.id },
  { header: "attempt", cell: (row) => row.attempt_id },
  { header: "base_sha", cell: (row) => row.base_sha },
  { header: "head_sha", cell: (row) => row.head_sha },
  { header: "tree_sha", cell: (row) => row.tree_sha },
  { header: "patch_digest", cell: (row) => row.patch_digest },
];

const INTENT_COLUMNS: Column<EffectIntentRow>[] = [
  { header: "state", cell: (row) => row.state },
  { header: "intent", cell: (row) => row.id },
  { header: "provider", cell: (row) => row.provider },
  { header: "logical_effect_key", cell: (row) => row.logical_effect_key },
  { header: "target", cell: (row) => row.target_identity },
  { header: "expected_old_oid", cell: (row) => row.expected_old_oid },
  { header: "desired_state_hash", cell: (row) => row.desired_state_hash },
  { header: "attempt/fence", cell: (row) => `${row.attempt_id} @ ${row.fence}` },
  { header: "policy_version", cell: (row) => row.policy_version },
  { header: "unknown_retries", cell: (row) => String(row.unknown_retries) },
  { header: "created_at", cell: (row) => row.created_at },
  { header: "provider_idempotency_key", cell: (row) => nullable(row.provider_idempotency_key, "none") },
];

const RECEIPT_COLUMNS: Column<EffectReceiptRow>[] = [
  { header: "verdict", cell: (row) => row.verification_result },
  { header: "receipt", cell: (row) => row.id },
  { header: "intent", cell: (row) => row.effect_intent_id },
  { header: "observed_remote_identity", cell: (row) => row.observed_remote_identity },
  { header: "observed_state_hash", cell: (row) => nullable(row.observed_state_hash, "absent") },
  { header: "method", cell: (row) => row.verification_method },
  { header: "adopted_after_unknown", cell: (row) => String(row.adopted_after_unknown) },
  { header: "recorded_at", cell: (row) => row.recorded_at },
];

const EFFECT_COLUMNS: Column<EffectRow>[] = [
  { header: "outcome", cell: (row) => row.outcome },
  { header: "effect", cell: (row) => row.id },
  { header: "attempt", cell: (row) => row.attempt_id },
  { header: "logical_key", cell: (row) => row.logical_key },
  { header: "desired", cell: (row) => row.desired },
];

export function MergeRailPage({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadMergeRail);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body, asOf) => (
        <>
          <p data-testid="merge-rail-summary">
            candidates {body.candidates.length} · intents {body.intents.length} · receipts{" "}
            {body.receipts.length} · first-slice effects {body.effects.length} · OUTCOME_UNKNOWN{" "}
            {body.intent_state_counts.find((row) => row.label === "OUTCOME_UNKNOWN")?.count ??
              "unknown"}
          </p>
          <RowsTable
            id="merge-rail-states"
            label="effect intents by state"
            asOf={asOf}
            columns={COUNT_COLUMNS}
            rows={body.intent_state_counts}
          />
          <RowsTable
            id="merge-rail-candidates"
            label="candidates"
            asOf={asOf}
            columns={CANDIDATE_COLUMNS}
            rows={body.candidates}
          />
          <RowsTable
            id="merge-rail-intents"
            label="effect intents"
            asOf={asOf}
            columns={INTENT_COLUMNS}
            rows={body.intents}
          />
          <RowsTable
            id="merge-rail-receipts"
            label="effect receipts"
            asOf={asOf}
            columns={RECEIPT_COLUMNS}
            rows={body.receipts}
          />
          <RowsTable
            id="merge-rail-effects"
            label="first-slice effects"
            asOf={asOf}
            columns={EFFECT_COLUMNS}
            rows={body.effects}
          />
        </>
      )}
    </ProjectionCard>
  );
}
