import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, errorText, forgetBrowserSession } from "../../api";
import { useOperatorSnapshot } from "../../hooks/useOperatorSnapshot";
import {
  getConversation,
  HEAD_RUNTIME_BINDING_REQUIRED,
  listConversations,
  loadPendingConversation,
  SLACK_BIND_UNAVAILABLE,
  submitConversation,
  TELEGRAM_UNAVAILABLE,
  type ConversationCursor,
  type ConversationIndexView,
  type ConversationView,
} from "./talk";

export function TalkDrawer() {
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="talk-root" data-testid="talk-drawer">
      <button
        type="button"
        className="talk-launch"
        aria-expanded={open}
        aria-controls={titleId}
        onClick={() => setOpen((value) => !value)}
      >
        Head
      </button>
      {open ? <TalkPanel titleId={titleId} /> : null}
    </div>
  );
}

function TalkPanel({ titleId }: { titleId: string }) {
  const snapshot = useOperatorSnapshot();
  const generation = useRef(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [index, setIndex] = useState<ConversationIndexView | null>(null);
  const [thread, setThread] = useState<ConversationView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cite, setCite] = useState<string | null>(null);
  const [indexIncomplete, setIndexIncomplete] = useState(false);
  const [pageIncomplete, setPageIncomplete] = useState(false);
  const live =
    snapshot.kind === "value"
      ? snapshot.body.fleet.leases.filter((lease) => lease.liveness === "live").length
      : null;
  const unbound = (thread?.head_blocker ?? HEAD_RUNTIME_BINDING_REQUIRED) === HEAD_RUNTIME_BINDING_REQUIRED;

  const fail = (caught: unknown, current: number): void => {
    if (generation.current !== current) return;
    if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
      forgetBrowserSession();
      setThread(null);
      setIndex(null);
      setCite(null);
      setSelectedId(null);
    }
    setError(errorText(caught));
    setPending(false);
  };

  const loadThread = async (id: string, current: number): Promise<ConversationCursor | null> => {
    const page = await getConversation(id);
    if (generation.current !== current) return null;
    setThread(page.data);
    setSelectedId(id);
    setPageIncomplete(page.data.next_after !== null);
    setCite(`${page.source} · as_of_sequence ${page.asOfSequence} · observed_at ${page.observedAt}`);
    return page.data.cursor;
  };

  const refreshIndex = async (current: number): Promise<void> => {
    const page = await listConversations();
    if (generation.current !== current) return;
    setIndex(page.data);
    setIndexIncomplete(page.data.next_after !== null);
    if (thread === null) {
      setCite(`${page.source} · as_of_sequence ${page.asOfSequence} · observed_at ${page.observedAt}`);
    }
  };

  useEffect(() => {
    const current = generation.current + 1;
    generation.current = current;
    const pendingConversation = ((): ReturnType<typeof loadPendingConversation> => {
      try {
        return loadPendingConversation();
      } catch (caught: unknown) {
        fail(caught, current);
        return null;
      }
    })();
    const payload = pendingConversation?.envelope.payload as { content?: unknown } | undefined;
    if (typeof payload?.content === "string") setDraft(payload.content);
    void refreshIndex(current)
      .then(() => {
        const journaled = pendingConversation?.envelope.payload as { cursor?: ConversationCursor | null } | undefined;
        const resume = journaled?.cursor?.conversation_id;
        if (resume !== undefined && resume !== null) return loadThread(resume, current);
        return null;
      })
      .catch((caught: unknown) => fail(caught, current));
    return () => {
      generation.current += 1;
    };
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending || pageIncomplete) return;
    const current = generation.current + 1;
    generation.current = current;
    const submitted = draft;
    setPending(true);
    setError(null);
    void submitConversation(submitted, thread?.cursor ?? null)
      .then((receipt) => loadThread(receipt.cursor.conversation_id, current))
      .then(() => refreshIndex(current))
      .then(() => {
        if (generation.current !== current) return;
        setPending(false);
        setDraft((currentDraft) => (currentDraft === submitted ? "" : currentDraft));
      })
      .catch((caught: unknown) => fail(caught, current));
  };

  return (
    <aside className="talk-panel" aria-labelledby={titleId}>
      <header className="talk-head">
        <p id={titleId} className="talk-title">
          Head of Gas Town
        </p>
        <p className="talk-tag idle">Schema-27 conversation_message overlay · not a 16th surface · not G15 cognition</p>
        <div className="talk-chips" aria-label="operating status from operator snapshot">
          <span className="chip chip-hold">HOLD</span>
          <span className={live === 0 || live === null ? "chip chip-idle" : "chip chip-live"}>
            LIVE {live === null ? "unknown" : live}
          </span>
          <span className={unbound ? "chip chip-hold" : "chip chip-live"}>{unbound ? "UNBOUND" : "BOUND"}</span>
          <span className="chip chip-unknown">STOP_UNIMPLEMENTED</span>
        </div>
      </header>
      <div className="talk-thread">
        {index !== null && index.conversations.length > 0 ? (
          <label className="talk-label idle" htmlFor="talk-thread-select">
            Owned threads
            <select
              id="talk-thread-select"
              value={selectedId ?? ""}
              disabled={pending}
              onChange={(event) => {
                const id = event.target.value;
                const current = generation.current + 1;
                generation.current = current;
                setSelectedId(id === "" ? null : id);
                if (id === "") {
                  setThread(null);
                  setPageIncomplete(false);
                  return;
                }
                void loadThread(id, current).catch((caught: unknown) => fail(caught, current));
              }}
            >
              <option value="">Select a server thread</option>
              {index.conversations.map((row) => (
                <option key={row.cursor.conversation_id} value={row.cursor.conversation_id}>
                  {row.preview}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {thread?.messages.map((message) => (
          <p key={message.cursor.message_id} className={message.role === "user" ? "talk-user" : "talk-assistant"}>
            {message.content}
          </p>
        ))}
        {thread === null ? (
          <p className="talk-cite idle">
            GET /api/v1/conversations is the thread of record. No local transcript. Assistant rows require a native
            Head outcome.
          </p>
        ) : null}
        {cite ? <p className="talk-cite idle">{cite}</p> : null}
        {indexIncomplete ? (
          <p className="talk-refuse pending">
            CONVERSATION_INDEX_INCOMPLETE: more owned threads remain after this snapshot page
          </p>
        ) : null}
        {pageIncomplete ? (
          <p className="talk-refuse pending">
            CONVERSATION_PAGE_INCOMPLETE: composer waits until the current snapshot page reaches the tip
          </p>
        ) : null}
        <p className="talk-refuse pending" data-testid="talk-blocker">
          {thread?.head_blocker ?? HEAD_RUNTIME_BINDING_REQUIRED}
        </p>
        {error ? (
          <p className="talk-refuse pending" data-testid="talk-error">
            {error}
          </p>
        ) : null}
        <p className="talk-cite idle">{SLACK_BIND_UNAVAILABLE}</p>
        <p className="talk-cite idle">{TELEGRAM_UNAVAILABLE}</p>
      </div>
      <form className="talk-form" onSubmit={submit}>
        <label className="talk-label idle" htmlFor="talk-line">
          Message the Head
        </label>
        <textarea
          id="talk-line"
          className="talk-input"
          rows={3}
          value={draft}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="how's the fleet"
        />
        <button type="submit" disabled={pending || pageIncomplete}>
          {pending ? "Sending" : "Send"}
        </button>
      </form>
    </aside>
  );
}
