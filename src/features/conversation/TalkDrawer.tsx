import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useEventStream } from "../../hooks/useEventStream";
import { useConversation } from "./useConversation";
import { payloadOf, validateContent } from "./contracts";
import { effectiveStatus, envelopeOf } from "./journal";
import { SubmissionObservations } from "./SubmissionObservations";

function Updates({ refresh }: { refresh: () => Promise<number | null> }) {
  const latest = useRef(refresh); latest.current = refresh;
  const reconcile = useCallback(() => latest.current(), []);
  const changed = useCallback(() => { void latest.current(); }, []);
  const stream = useEventStream(reconcile, changed);
  return <p role="status" className="talk-cite idle">{stream.stale ? "Updates interrupted. Resynchronizing from saved records." :
    stream.connection === "live" ? "Connected to updates" : "Reconnecting to updates"}</p>;
}

export function TalkDrawer() {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const talk = useConversation(open);
  useEffect(() => {
    if (!open) return;
    editor.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); launcher.current?.focus(); };
  }, [open]);
  const thread = talk.thread?.data;
  const saved = talk.submission;
  const savedStatus = saved === null ? null : effectiveStatus(saved);
  const blocked = thread?.head_blocker;
  const canSubmit = !talk.busy && talk.owner !== null &&
    (saved === null || saved.refreshed) && validateContent(talk.draft);
  return <div className="talk-root" data-testid="talk-drawer">
    <button ref={launcher} type="button" className="talk-launch" aria-expanded={open} aria-controls={`${titleId}-panel`}
      onClick={() => setOpen((value) => !value)}>Head</button>
    {open && <aside id={`${titleId}-panel`} className="talk-panel" aria-labelledby={titleId}>
      <header className="talk-head">
        <h2 id={titleId} className="talk-title">Talk with the Head</h2>
        <button type="button" onClick={() => setOpen(false)}>Close conversation</button>
      </header>
      <div className="talk-thread">
        <Updates refresh={talk.refresh} />
        <button type="button" disabled={talk.busy} onClick={() => { void talk.refresh(); }}>Refresh conversations</button>
        <label className="talk-label" htmlFor={`${titleId}-threads`}>Conversation</label>
        <select id={`${titleId}-threads`} value={talk.selected ?? ""} onChange={(event) => talk.select(event.target.value || null)}>
          <option value="">New conversation</option>
          {talk.selected !== null && !talk.index?.data.conversations.some((row) => row.cursor.conversation_id === talk.selected) &&
            <option value={talk.selected}>Selected conversation</option>}
          {talk.index?.data.conversations.map((row) => <option key={row.cursor.conversation_id} value={row.cursor.conversation_id}>{row.preview}</option>)}
        </select>
        {talk.index?.data.next_after != null && <button type="button" disabled={talk.busy} onClick={talk.moreThreads}>Load more conversations</button>}
        {thread?.messages.map((message) => <p key={message.cursor.message_id} className={message.role === "user" ? "talk-user" : "talk-assistant"}>{message.content}</p>)}
        {thread?.next_after != null && <button type="button" disabled={talk.busy} onClick={talk.moreMessages}>Load more messages</button>}
        {talk.thread && <p className="talk-cite idle">Observed {talk.thread.observedAt} · record {talk.thread.asOfSequence}</p>}
        {blocked && <p className="talk-refuse pending" data-testid="talk-blocker">{blocked === "HEAD_RUNTIME_BINDING_REQUIRED" ?
          "Messages are saved. Head execution is awaiting runtime admission." : `Head is waiting: ${blocked}`}</p>}
        {saved && <section aria-label="Preserved submission">
          <p>A submission is preserved for this operator. Its observed outcome is {savedStatus?.status ?? "unresolved"}.</p>
          <p className="talk-user">{payloadOf(envelopeOf(saved)).content}</p>
          <button type="button" disabled={talk.busy} onClick={() => talk.send(true)}>Reconcile preserved submission</button>
          {savedStatus !== null && ["FAILED", "UNKNOWN"].includes(savedStatus.status) &&
            <button type="button" disabled={talk.busy} onClick={talk.archive}>Keep this unresolved record and allow another message</button>}
        </section>}
        {talk.history.length > 0 && <details>
          <summary>Saved submissions</summary>
          {talk.history.map((row) => <details key={row.id}>
            <summary>{row.refreshed ? "Message observed" : row.status?.status ?? "Outcome unresolved"} · {row.id}</summary>
            <p>{payloadOf(envelopeOf(row)).content}</p>
            {row.reconciledStatus && <p>Original receipt: {row.status?.status}. Later authoritative observation: {row.reconciledStatus.status}.</p>}
            <button type="button" disabled={talk.busy} onClick={() => talk.reconcile(row)}>Reconcile this submission</button>
            {talk.owner !== null && <SubmissionObservations key={`${row.id}:${row.refreshed}:${row.reconciledStatus?.status ?? row.status?.status}`} owner={talk.owner} row={row} />}
          </details>)}
          {talk.historyAfter !== null && <button type="button" disabled={talk.busy} onClick={talk.moreHistory}>Load more saved submissions</button>}
        </details>}
        {talk.error && <p className="talk-refuse pending" role="alert" data-testid="talk-error">{talk.error}</p>}
      </div>
      <form className="talk-form" onSubmit={(event) => { event.preventDefault(); if (canSubmit) talk.send(); }}>
        <label className="talk-label" htmlFor={`${titleId}-message`}>Message the Head</label>
        <textarea ref={editor} id={`${titleId}-message`} className="talk-input" rows={3} value={talk.draft}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.ctrlKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); if (canSubmit) talk.send();
            }
          }}
          onChange={(event) => talk.setDraft(event.target.value)} placeholder="Describe your goal" />
        <button type="submit" disabled={!canSubmit}>
          {talk.busy ? "Working…" : "Send message"}
        </button>
      </form>
    </aside>}
  </div>;
}
