import type { OutboxItem, OutboxView } from "../generated/api";
import type { Loadable } from "../loadable";
import { renderObservation } from "../observation";

const PHASE_CLASS: Record<string, string> = {
  pending: "pending",
  applied: "pending",
  verified: "unknown",
};

function phaseClass(phase: string): string {
  return PHASE_CLASS[phase] ?? "unknown";
}

function phaseLabel(phase: string): string {
  return phase === "verified" ? `${phase} (receipt unavailable)` : phase;
}

export function OutboxCard({ outbox }: { outbox: Loadable<OutboxView> }) {
  return (
    <section className="card" data-testid="outbox">
      <h2>Outbox commands</h2>
      <OutboxBody outbox={outbox} />
    </section>
  );
}

function OutboxBody({ outbox }: { outbox: Loadable<OutboxView> }) {
  if (outbox.kind === "loading") {
    return <p className="idle">loading outbox</p>;
  }
  if (outbox.kind === "unknown") {
    return (
      <>
        <p className="unknown" data-testid="outbox-unknown">
          {renderObservation({ kind: "unknown", text: outbox.reason })}
        </p>
        <p className="source">source: {outbox.source} (observed {outbox.observedAt})</p>
      </>
    );
  }
  return (
    <>
      {outbox.value.items.length === 0 ? (
        <p className="idle" data-testid="outbox-empty">
          outbox: empty (observed)
        </p>
      ) : (
        <ul>
          {outbox.value.items.map((item) => (
            <OutboxRow key={item.seq} item={item} />
          ))}
        </ul>
      )}
      <p className="source">source: {outbox.source} via GET /api/v1/outbox (observed {outbox.observedAt})</p>
    </>
  );
}

function OutboxRow({ item }: { item: OutboxItem }) {
  return (
    <li>
      <span className={phaseClass(item.phase)} data-testid={`outbox-phase-${item.seq}`}>
        {phaseLabel(item.phase)}
      </span>{" "}
      — seq {item.seq} · {item.kind}
      {item.delivered_at !== null ? ` · delivered ${item.delivered_at}` : ""}
      {item.acked_at !== null ? ` · acked ${item.acked_at}` : ""}
    </li>
  );
}
