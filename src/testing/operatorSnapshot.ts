// Explicit component-test fixture. Never imported by product code.
import type { OperatorSnapshotView } from "../generated/api";

export const OPERATOR_OBSERVED_AT = "2026-08-25T00:00:00.000Z";

export function operatorSnapshotFixture(sequence = 0): OperatorSnapshotView {
  return {
    missions: [], graphs: [], outbox: { items: [] }, ready: null,
    fleet: { authority_time: OPERATOR_OBSERVED_AT, leases: [], ready_queue: [] },
    sessions: { attempts: [], state_counts: [] },
    context_lineage: { capsules: [] },
    merge_rail: { candidates: [], effects: [], intents: [], receipts: [], intent_state_counts: [] },
    quality_lab: { evidence: [], outcome_counts: [] },
    audit: {
      latest_sequence: sequence, tail_window: 64,
      events: Array.from({ length: Math.min(sequence, 64) }, (_, index) => {
        const seq = Math.max(1, sequence - 63) + index;
        return { id: seq.toString(16).padStart(64, "0"), seq, at: OPERATOR_OBSERVED_AT,
          kind: "component_fixture", body: "{}", stream_id: null, correlation_id: null };
      }),
    },
  };
}
