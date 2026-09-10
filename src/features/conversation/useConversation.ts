import { useEffect, useRef, useState } from "react";
import { errorText, type SnapshotRead } from "../../api";
import { onBrowserSessionChange } from "../../apiSession";
import { discoverOwner, assertOwner, forgetRefusedOwner, type ConversationOwner } from "./owner";
import { archiveSubmission, effectiveStatus, envelopeOf, listSubmissions, loadSubmission, type Submission } from "./journal";
import { getConversation, listConversations, payloadOf, readConversationWindow, reconcileSubmission,
  readConversationIndexWindow, submitConversation, type ConversationIndexView, type ConversationView } from "./talk";
import { receiptFor } from "./contracts";

type State = {
  owner: ConversationOwner | null;
  index: SnapshotRead<ConversationIndexView> | null;
  thread: SnapshotRead<ConversationView> | null;
  selected: string | null;
  draft: string;
  draftRevision: string;
  submission: Submission | null;
  history: Submission[];
  historyAfter: string | null;
  busy: boolean;
  error: string | null;
};
const empty = (): State => ({ owner: null, index: null, thread: null, selected: null,
  draft: "", draftRevision: crypto.randomUUID(), submission: null, history: [], historyAfter: null, busy: false, error: null });
type Update = (update: Partial<State> | ((previous: State) => Partial<State>)) => void;

export function useConversation(enabled: boolean) {
  const [state, setState] = useState<State>(empty);
  const current = useRef(state); current.current = state;
  const active = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const explicitSelection = useRef(false);
  const latestRefresh = useRef<() => Promise<number | null>>(async () => null);

  async function historyWindow(owner: ConversationOwner, visible: number): Promise<Submission[]> {
    const rows = await listSubmissions(owner);
    let page = rows;
    while (page.length === 100 && rows.length < visible) {
      page = await listSubmissions(owner, rows.at(-1)!.id);
      if (page.some((row) => rows.some((previous) => previous.id === row.id))) {
        throw new Error("CONVERSATION_JOURNAL_INVALID: saved history repeated a submission");
      }
      rows.push(...page);
    }
    return rows;
  }

  async function run(action: (owner: ConversationOwner, signal: AbortSignal, update: Update) => Promise<number | void>): Promise<number | null> {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const expected = current.current.owner;
    busy.current = true; setState((old) => ({ ...old, busy: true, error: null }));
    let owner: ConversationOwner | null = null;
    const update: Update = (changes) => {
      if (active.current !== controller || controller.signal.aborted) return;
      if (owner !== null) assertOwner(owner, controller.signal);
      setState((old) => {
        if (active.current !== controller || controller.signal.aborted) return old;
        try { if (owner !== null) assertOwner(owner, controller.signal); } catch { return old; }
        return { ...old, ...(typeof changes === "function" ? changes(old) : changes) };
      });
    };
    try {
      owner = await discoverOwner(controller.signal);
      if (expected !== null && (expected.operatorId !== owner.operatorId || expected.sessionId !== owner.sessionId ||
          expected.epoch !== owner.epoch)) throw new Error("CONVERSATION_OWNER_CHANGED: refresh to observe your current session");
      update({ owner });
      const watermark = await action(owner, controller.signal, update);
      assertOwner(owner, controller.signal);
      return watermark ?? null;
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) {
        if (owner !== null || expected !== null) forgetRefusedOwner((owner ?? expected)!, error);
        const text = errorText(error);
        setState((old) => {
          if (active.current !== controller || controller.signal.aborted) return old;
          if (text.includes("CONVERSATION_OWNER_CHANGED") || text.includes("SESSION_CHANGED")) {
            return { ...empty(), error: text };
          }
          return { ...old, error: text };
        });
      }
      return null;
    } finally {
      if (active.current === controller) {
        busy.current = false;
        setState((old) => ({ ...old, busy: false }));
      }
    }
  }

  async function refresh(): Promise<number | null> {
    if (busy.current) return null;
    const previous = current.current;
    return run(async (owner, signal, update) => {
      const submission = await loadSubmission(owner);
      assertOwner(owner, signal);
      const history = await historyWindow(owner, previous.history.length);
      const index = await readConversationIndexWindow(owner, previous.index?.data.conversations.length, signal);
      if (previous.index !== null && index.asOfSequence < previous.index.asOfSequence) {
        throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: refresh the conversation index");
      }
      update({ index, submission, history, historyAfter: history.length > 0 && history.length % 100 === 0 ? history.at(-1)!.id : null });
      if (submission !== null) update((old) => {
        if (submission.refreshed) return old.draftRevision === submission.draftRevision ? { draft: "" } : {};
        return old.draft === "" ? { draft: payloadOf(envelopeOf(submission)).content,
          draftRevision: submission.draftRevision ?? envelopeOf(submission).idempotency_key } : {};
      });
      const recovered = submission === null ? null : submission.refreshed && submission.status !== null
        ? receiptFor(effectiveStatus(submission)!, envelopeOf(submission), owner.operatorId).cursor.conversation_id
        : payloadOf(envelopeOf(submission)).cursor?.conversation_id ?? null;
      const selected = previous.selected ?? (explicitSelection.current ? null : recovered);
      if (selected !== null) {
        const visibleMessages = previous.thread?.data.cursor.conversation_id === selected
          ? previous.thread.data.messages.length : undefined;
        const thread = await readConversationWindow(owner, selected, visibleMessages, signal);
        if (previous.thread !== null && previous.thread.data.cursor.conversation_id === selected &&
            (thread.asOfSequence < previous.thread.asOfSequence || thread.data.cursor.sequence < previous.thread.data.cursor.sequence)) {
          throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: refresh the conversation");
        }
        update({ thread, selected });
        return Math.min(index.asOfSequence, thread.asOfSequence);
      }
      return index.asOfSequence;
    });
  }
  latestRefresh.current = refresh;

  useEffect(() => onBrowserSessionChange(() => {
    explicitSelection.current = false;
    active.current?.abort(); active.current = null; busy.current = false; setState(empty());
  }), []);
  useEffect(() => {
    if (!enabled) return;
    void latestRefresh.current();
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void latestRefresh.current(); };
    const timer = setInterval(refreshVisible, 10_000);
    window.addEventListener("focus", refreshVisible);
    return () => {
      active.current?.abort(); active.current = null; busy.current = false;
      setState((old) => ({ ...old, busy: false }));
      clearInterval(timer); window.removeEventListener("focus", refreshVisible);
    };
  }, [enabled]);

  function select(id: string | null): void {
    explicitSelection.current = true;
    active.current?.abort(); busy.current = false;
    setState((old) => ({ ...old, selected: id, thread: null, error: null, busy: false }));
    if (id === null) return;
    void run(async (owner, signal, update) => {
      const thread = await getConversation(owner, id, 0, undefined, signal);
      update({ selected: id, thread });
    });
  }

  function moreThreads(): void {
    if (busy.current) return;
    const previous = current.current.index;
    if (previous?.data.next_after == null) return;
    void run(async (owner, signal, update) => {
      const page = await listConversations(owner, previous.data.next_after!, signal);
      const known = new Set(previous.data.conversations.map((row) => row.cursor.conversation_id));
      if (page.asOfSequence < previous.asOfSequence || page.data.conversations.some((row) => known.has(row.cursor.conversation_id))) {
        throw new Error("CONVERSATION_INDEX_CHANGED: refresh your thread list");
      }
      update({ index: { ...page, data: { ...page.data, conversations: [...previous.data.conversations, ...page.data.conversations] } } });
    });
  }

  function moreMessages(): void {
    if (busy.current) return;
    const previous = current.current.thread;
    if (previous?.data.next_after == null) return;
    void run(async (owner, signal, update) => {
      const page = await getConversation(owner, previous.data.cursor.conversation_id, previous.data.next_after!, previous.data.messages.at(-1)?.cursor.message_id, signal);
      const known = new Set(previous.data.messages.map((row) => row.command_id));
      if (page.asOfSequence < previous.asOfSequence || page.data.cursor.sequence < previous.data.cursor.sequence ||
          page.data.messages.some((row) => known.has(row.command_id))) throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: refresh the thread");
      update({ thread: { ...page, data: { ...page.data, messages: [...previous.data.messages, ...page.data.messages] } } });
    });
  }

  function send(retry = false, historical?: Submission): void {
    if (busy.current) return;
    const original = current.current;
    void run(async (owner, signal, update) => {
      if (!retry && original.selected !== null &&
          original.thread?.data.cursor.conversation_id !== original.selected) {
        throw new Error("CONVERSATION_CURSOR_UNAVAILABLE: refresh the selected conversation before sending");
      }
      const row = historical ?? (retry ? await loadSubmission(owner) : null);
      if (retry && row === null) throw new Error("CONVERSATION_JOURNAL_CHANGED: refresh your preserved submission");
      try {
        const destination = row === null ? original.selected : payloadOf(envelopeOf(row)).cursor?.conversation_id ??
          (effectiveStatus(row)?.status === "APPLIED" ? receiptFor(effectiveStatus(row)!, envelopeOf(row), owner.operatorId).cursor.conversation_id : null);
        const visible = original.thread?.data.cursor.conversation_id === destination ? original.thread.data.messages.length : undefined;
        const result = row !== null ? await reconcileSubmission(owner, row, signal, visible) :
          await submitConversation(owner, original.draft, original.thread?.data.cursor ?? null, signal, original.draftRevision, visible);
        const preserved = await loadSubmission(owner);
        assertOwner(owner, signal);
        update({ submission: preserved });
        if (original.thread?.data.cursor.conversation_id === result.thread.data.cursor.conversation_id &&
            (result.thread.asOfSequence < original.thread.asOfSequence || result.thread.data.cursor.sequence < original.thread.data.cursor.sequence)) {
          throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: preserved newer visible conversation");
        }
        update({ thread: result.thread, selected: result.thread.data.cursor.conversation_id });
        if (historical === undefined) update((old) => ({ draft: old.draftRevision === original.draftRevision ? "" : old.draft }));
        const index = await readConversationIndexWindow(owner, original.index?.data.conversations.length, signal);
        if (index.asOfSequence < (original.index?.asOfSequence ?? 0) || index.asOfSequence < result.thread.asOfSequence) {
          throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: preserved newer conversation index");
        }
        const history = await historyWindow(owner, original.history.length);
        update({ index, history, historyAfter: history.length > 0 && history.length % 100 === 0 ? history.at(-1)!.id : null });
      } catch (error) {
        const preserved = await loadSubmission(owner);
        assertOwner(owner, signal);
        update({ submission: preserved });
        throw error;
      }
    });
  }

  function archive(): void {
    const original = current.current.submission;
    if (busy.current || original === null) return;
    void run(async (owner, signal, update) => {
      await archiveSubmission(owner, original);
      assertOwner(owner, signal);
      const history = await historyWindow(owner, current.current.history.length);
      update({ submission: null, history, historyAfter: history.length > 0 && history.length % 100 === 0 ? history.at(-1)!.id : null });
    });
  }

  function moreHistory(): void {
    const original = current.current;
    if (busy.current || original.historyAfter === null) return;
    void run(async (owner, signal, update) => {
      const rows = await listSubmissions(owner, original.historyAfter!);
      assertOwner(owner, signal);
      update({ history: [...original.history, ...rows], historyAfter: rows.length === 100 ? rows.at(-1)!.id : null });
    });
  }

  return { ...state, refresh, select, moreThreads, moreMessages, moreHistory, archive, send,
    reconcile: (row: Submission) => send(true, row),
    setDraft: (draft: string) => setState((old) => old.draft === draft ? old : { ...old, draft, draftRevision: crypto.randomUUID() }) };
}
