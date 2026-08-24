import type { OutboxView } from "../generated/api";
import type { Loadable } from "../loadable";
import { renderObservation } from "../observation";

export function OutboxCard({ outbox }: { outbox: Loadable<OutboxView> }) {
  return (
    <section className="card" data-testid="outbox">
      <h2>Pending commands</h2>
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
      <p className="unknown" data-testid="outbox-unknown">
        {renderObservation({ kind: "unknown", text: outbox.reason })}
      </p>
    );
  }
  return (
    <>
      {outbox.value.pending.length === 0 ? (
        <p className="verified" data-testid="outbox-empty">
          outbox: empty (verified)
        </p>
      ) : (
        <ul>
          {outbox.value.pending.map((commandId) => (
            <li key={commandId}>
              <span className="pending">pending</span> — {commandId}
            </li>
          ))}
        </ul>
      )}
      <p className="source">source: GET /v1/outbox (observed {outbox.observedAt})</p>
    </>
  );
}
