import type { DemoReceipt } from "../generated/api";

export function ReceiptCard({ receipt }: { receipt: DemoReceipt }) {
  return (
    <section className="card" data-testid="receipt">
      <h2>Demo receipt</h2>
      <dl>
        <dt>mission</dt>
        <dd>{receipt.mission_id}</dd>
        <dt>plan hash</dt>
        <dd>{receipt.plan_hash}</dd>
        <dt>fence</dt>
        <dd>{receipt.fence}</dd>
        <dt>live attempt</dt>
        <dd>{receipt.attempt_id}</dd>
        <dt>stale attempt</dt>
        <dd>{receipt.stale_attempt_id}</dd>
        <dt>stale refused</dt>
        <dd>{String(receipt.stale_refused)}</dd>
        <dt>candidate head</dt>
        <dd>{receipt.candidate_head}</dd>
        <dt>evidence</dt>
        <dd>{receipt.evidence_result}</dd>
        <dt>effect</dt>
        <dd>{receipt.effect_outcome}</dd>
        <dt>materialize idempotent</dt>
        <dd>{String(receipt.materialize_idempotent)}</dd>
      </dl>
    </section>
  );
}
