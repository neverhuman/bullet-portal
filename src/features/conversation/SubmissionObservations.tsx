import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api";
import { onBrowserSessionChange } from "../../apiSession";
import { assertOwner, verifyOwner, type ConversationOwner } from "./owner";
import { listSubmissionObservationPage, type ObservationPage, type Submission } from "./journal";

export function SubmissionObservations({ owner, row }: { owner: ConversationOwner; row: Submission }) {
  const [page, setPage] = useState<ObservationPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const clear = () => { generation.current += 1; setPage(null); setBusy(false); setError(null); };
    clear(); const unsubscribe = onBrowserSessionChange(clear);
    return () => { generation.current += 1; unsubscribe(); };
  }, [owner.origin, owner.operatorId, owner.epoch, row.id]);
  async function read(after = 0): Promise<void> {
    const request = ++generation.current;
    setBusy(true); setError(null);
    try {
      const current = await verifyOwner(owner);
      if (request !== generation.current) return;
      const next = await listSubmissionObservationPage(current, row, after);
      assertOwner(current);
      if (request !== generation.current) return;
      setPage((previous) => ({ ...next, observations: after === 0 ? next.observations : [...(previous?.observations ?? []), ...next.observations] }));
    } catch (error) {
      if (request === generation.current) setError(errorText(error));
    } finally { if (request === generation.current) setBusy(false); }
  }
  return <section aria-label={`Observed outcomes for ${row.id}`} aria-busy={busy}>
    <button type="button" disabled={busy} onClick={() => { void read(); }}>{page === null ? "Show observed outcomes" : "Refresh observed outcomes"}</button>
    {page !== null && <>
      <p>Saved local observations, including later reconciliation and contradictions. These do not grant execution or integration authority.</p>
      {page.observations.length === 0 ? <p>No local outcome observations saved.</p> : <ol>
        {page.observations.map((observation) => <li key={observation.sequence}>
          <time dateTime={observation.observedAt}>{observation.observedAt}</time> · {observation.status.status} · local observation {observation.sequence}
        </li>)}
      </ol>}
      {page.nextAfter !== null && <button type="button" disabled={busy} onClick={() => { void read(page.nextAfter!); }}>Load more observed outcomes</button>}
    </>}
    {busy && <p role="status">Reading saved outcomes…</p>}
    {error && <p role="alert">Saved outcomes unavailable: {error}</p>}
  </section>;
}
