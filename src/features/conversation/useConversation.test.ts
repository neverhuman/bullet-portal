import { discoverOwner } from "./owner";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, type SnapshotRead } from "../../api";
import { SNAPSHOT_SOURCE } from "../../apiValidation";
import { getOperatorSession } from "../../apiAuth";
import { csrfToken, forgetBrowserSession, rememberCsrfToken } from "../../apiSession";
import type { ConversationView } from "./contracts";
import { archiveSubmission, listSubmissions, loadSubmission } from "./journal";
import { getConversation, listConversations, readConversationWindow, readConversationIndexWindow, reconcileSubmission, submitConversation } from "./talk";
import { conversationEnvelope } from "./contracts";
import { prepareCommand } from "../../commandIdentity";
import type { Submission } from "./journal";
import { useConversation } from "./useConversation";
import { applied } from "./fixture.test-support";

vi.mock("../../apiAuth", () => ({ getOperatorSession: vi.fn() }));
vi.mock("./journal", async (original) => ({ ...await original<object>(), listSubmissions: vi.fn(), loadSubmission: vi.fn(), archiveSubmission: vi.fn() }));
vi.mock("./talk", async (original) => ({ ...await original<object>(), getConversation: vi.fn(),
  listConversations: vi.fn(), readConversationIndexWindow: vi.fn(), readConversationWindow: vi.fn(),
  reconcileSubmission: vi.fn(), submitConversation: vi.fn() }));
const session = { status: "AUTHENTICATED" as const, operator_id: `opr_${"1".repeat(64)}`,
  session_id: `sid_${"2".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" };
const id = `cnv_${"3".repeat(64)}`;
const cursor = { conversation_id: id, message_id: `msg_${"4".repeat(64)}`, sequence: 1 };
const snapshot = <T,>(data: T): SnapshotRead<T> => ({ data, asOfSequence: 10,
  observedAt: "2026-09-10T00:00:00Z", source: SNAPSHOT_SOURCE });
const thread = snapshot<ConversationView>({ cursor, messages: [], next_after: null, head_blocker: "HEAD_RUNTIME_BINDING_REQUIRED" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  rememberCsrfToken("original");
  vi.mocked(getOperatorSession).mockResolvedValue(session);
  vi.mocked(listSubmissions).mockResolvedValue([]);
  vi.mocked(loadSubmission).mockResolvedValue(null);
  vi.mocked(listConversations).mockResolvedValue(snapshot({ conversations: [{ cursor, preview: "Private goal",
    created_at: "2026-09-10T00:00:00Z", last_activity_at: "2026-09-10T00:00:00Z" }], next_after: null }));
  vi.mocked(readConversationIndexWindow).mockImplementation((...args) => listConversations(args[0], 0, args[2]));
  vi.mocked(getConversation).mockResolvedValue(thread);
  vi.mocked(readConversationWindow).mockResolvedValue(thread);
});
afterEach(() => { cleanup(); forgetBrowserSession(); vi.resetAllMocks(); });

it("clears private projections and drafts when owner discovery is refused", async () => {
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.index).not.toBeNull());
  act(() => result.current.setDraft("private draft"));
  vi.mocked(getOperatorSession).mockRejectedValueOnce(new ApiError("GET", "/auth/session", 401, "expired"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current).toMatchObject({ owner: null, index: null, thread: null, draft: "", history: [] });
  expect(csrfToken()).toBeNull();
});

it("refuses sending to a selected conversation whose cursor failed to load", async () => {
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.busy).toBe(false));
  vi.mocked(getConversation).mockRejectedValueOnce(new Error("temporary read failure"));
  act(() => result.current.select(id));
  await waitFor(() => expect(result.current.error).toContain("temporary read failure"));
  act(() => result.current.setDraft("continue this conversation"));
  act(() => result.current.send());
  await waitFor(() => expect(result.current.error).toContain("CONVERSATION_CURSOR_UNAVAILABLE"));
  expect(submitConversation).not.toHaveBeenCalled();
  expect(result.current.selected).toBe(id);
});

it("ignores a late send after thread switching and preserves a newer draft", async () => {
  const response = deferred<Awaited<ReturnType<typeof submitConversation>>>();
  vi.mocked(submitConversation).mockReturnValueOnce(response.promise);
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.setDraft("original message"));
  act(() => result.current.send());
  await waitFor(() => expect(submitConversation).toHaveBeenCalledOnce());
  const signal = vi.mocked(submitConversation).mock.calls[0]![3]!;
  act(() => result.current.select(null));
  act(() => result.current.setDraft("next goal"));
  await act(async () => { response.resolve({ thread, submission: {} as never }); await response.promise; });
  expect(signal.aborted).toBe(true);
  expect(result.current).toMatchObject({ selected: null, thread: null, draft: "next goal" });
});

it("preserves text typed while a current send completes", async () => {
  const response = deferred<Awaited<ReturnType<typeof submitConversation>>>();
  vi.mocked(submitConversation).mockReturnValueOnce(response.promise);
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.setDraft("original"));
  act(() => result.current.send());
  await waitFor(() => expect(submitConversation).toHaveBeenCalledOnce());
  act(() => result.current.setDraft("followup"));
  await act(async () => { response.resolve({ thread, submission: {} as never }); await response.promise; });
  expect(result.current).toMatchObject({ selected: id, draft: "followup" });
});

it("does not clear a replacement session on a late refused owner discovery", async () => {
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  const response = deferred<typeof session>();
  vi.mocked(getOperatorSession).mockReturnValueOnce(response.promise);
  let refreshing!: Promise<number | null>;
  act(() => { refreshing = result.current.refresh(); });
  act(() => rememberCsrfToken("replacement"));
  act(() => result.current.setDraft("new session draft"));
  await act(async () => {
    response.reject(new ApiError("GET", "/auth/session", 403, "replaced"));
    await refreshing;
  });
  expect(csrfToken()).toBe("replacement");
  expect(result.current.draft).toBe("new session draft");
});

it("keeps a draft revision across unchanged edits and drawer detach", async () => {
  const { result, rerender } = renderHook(({ enabled }) => useConversation(enabled), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.setDraft("unchanged"));
  const revision = result.current.draftRevision;
  act(() => result.current.setDraft("unchanged"));
  rerender({ enabled: false }); rerender({ enabled: true });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.draftRevision).toBe(revision);
  act(() => result.current.setDraft("intentional change"));
  expect(result.current.draftRevision).not.toBe(revision);
});

it("retains loaded conversation index pages during ordinary refresh", async () => {
  const first = snapshot({ conversations: [{ cursor, preview: "first", created_at: session.issued_at,
    last_activity_at: session.issued_at }], next_after: 5 });
  const next = snapshot({ conversations: [{ ...first.data.conversations[0]!,
    cursor: { ...cursor, conversation_id: `cnv_${"5".repeat(64)}` }, preview: "second" }], next_after: null });
  vi.mocked(readConversationIndexWindow).mockResolvedValueOnce(first);
  vi.mocked(listConversations).mockResolvedValueOnce(next);
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.busy).toBe(false));
  act(() => result.current.moreThreads());
  await waitFor(() => expect(result.current.index?.data.conversations).toHaveLength(2));
  vi.mocked(readConversationIndexWindow).mockResolvedValueOnce({ ...next,
    data: { ...next.data, conversations: [...first.data.conversations, ...next.data.conversations] } });
  await act(async () => { await result.current.refresh(); });
  expect(vi.mocked(readConversationIndexWindow).mock.calls.at(-1)?.[1]).toBe(2);
  expect(result.current.index?.data.conversations).toHaveLength(2);
});

it("reconciles the selected historical request without submitting or clearing a newer draft", async () => {
  const prepared = prepareCommand(conversationEnvelope("archived message", null));
  const row: Submission = { schema: 1, origin: window.location.origin, operatorId: session.operator_id,
    destination: "/api/v1/commands", id: prepared.subject.id, body: prepared.body, status: null, refreshed: false };
  vi.mocked(reconcileSubmission).mockResolvedValueOnce({ submission: row, thread });
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.setDraft("my next goal"));
  act(() => result.current.reconcile(row));
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(vi.mocked(reconcileSubmission).mock.calls[0]?.[1]).toBe(row);
  expect(submitConversation).not.toHaveBeenCalled();
  expect(result.current.draft).toBe("my next goal");
});

it("submits against the authoritative cursor while older message pages remain unloaded", async () => {
  const partial = { ...thread, data: { ...thread.data, cursor: { ...cursor, sequence: 10_001 }, next_after: 100 } };
  vi.mocked(getConversation).mockResolvedValueOnce(partial);
  vi.mocked(submitConversation).mockResolvedValueOnce({ submission: {} as never, thread });
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.select(id));
  await waitFor(() => expect(result.current.thread?.data.next_after).toBe(100));
  act(() => result.current.setDraft("new instruction")); act(() => result.current.send());
  await waitFor(() => expect(submitConversation).toHaveBeenCalledOnce());
  expect(vi.mocked(submitConversation).mock.calls[0]?.[2]).toEqual(partial.data.cursor);
});

function savedSubmission(content: string): Submission {
  const prepared = prepareCommand(conversationEnvelope(content, null));
  return { schema: 1, origin: location.origin, operatorId: session.operator_id, destination: "/api/v1/commands",
    id: prepared.subject.id, body: prepared.body, draftRevision: `draft-${content}`, status: null, refreshed: false };
}

it("discovers durable settlement after detach and clears only the unchanged draft", async () => {
  const { result, rerender } = renderHook(({ enabled }) => useConversation(enabled), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.setDraft("accepted draft"));
  const row = { ...savedSubmission("accepted draft"), draftRevision: result.current.draftRevision };
  const settled = { ...row, status: applied(row), refreshed: true };
  rerender({ enabled: false });
  vi.mocked(loadSubmission).mockResolvedValue(settled);
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.draft).toBe(""));
  expect(result.current.selected).toBe(settled.status.result.cursor.conversation_id);
  expect(submitConversation).not.toHaveBeenCalled();
  act(() => result.current.setDraft("intentional new draft"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.draft).toBe("intentional new draft");
});

it("restores an unresolved draft and reconciles its original saved row", async () => {
  const row = savedSubmission("recover me"); vi.mocked(loadSubmission).mockResolvedValue(row);
  vi.mocked(reconcileSubmission).mockResolvedValue({ submission: row, thread });
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current).toMatchObject({ draft: "recover me", draftRevision: row.draftRevision, submission: row });
  act(() => result.current.send(true));
  await waitFor(() => expect(reconcileSubmission).toHaveBeenCalledOnce());
  expect(vi.mocked(reconcileSubmission).mock.calls[0]?.[1]).toEqual(row);
  expect(submitConversation).not.toHaveBeenCalled();
});

it("preserves loaded history pages on refresh and archives only the selected saved row", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => savedSubmission(String(index)));
  const later = savedSubmission("later");
  vi.mocked(listSubmissions).mockResolvedValueOnce(rows).mockResolvedValueOnce([later]);
  vi.mocked(loadSubmission).mockResolvedValueOnce(later);
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.history).toHaveLength(100));
  act(() => result.current.moreHistory());
  await waitFor(() => expect(result.current.history).toHaveLength(101));
  expect(vi.mocked(listSubmissions).mock.calls[1]?.[1]).toBe(rows.at(-1)!.id);
  vi.mocked(listSubmissions).mockResolvedValueOnce(rows).mockResolvedValueOnce([later]);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.history).toHaveLength(101);
  vi.mocked(loadSubmission).mockResolvedValueOnce(later);
  vi.mocked(listSubmissions).mockResolvedValue([later]);
  await act(async () => { await result.current.refresh(); });
  act(() => result.current.archive());
  await waitFor(() => expect(archiveSubmission).toHaveBeenCalledOnce());
  expect(vi.mocked(archiveSubmission).mock.calls[0]?.[1]).toEqual(later);
  await waitFor(() => expect(result.current.submission).toBeNull());
  expect(result.current.history).toEqual([later]);
});

it("retains loaded message pages during refresh and rejects a regressing successor", async () => {
  const first = { ...thread, data: { ...thread.data, messages: [{ cursor, command_id: `cmd_${"7".repeat(64)}` } as never], next_after: 1 } };
  const next = { ...thread, data: { ...thread.data, cursor: { ...cursor, sequence: 2 },
    messages: [{ cursor: { ...cursor, sequence: 2 }, command_id: `cmd_${"8".repeat(64)}` } as never] } };
  vi.mocked(getConversation).mockResolvedValueOnce(first).mockResolvedValueOnce(next);
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.owner).not.toBeNull());
  act(() => result.current.select(id)); await waitFor(() => expect(result.current.thread?.data.next_after).toBe(1));
  act(() => result.current.moreMessages()); await waitFor(() => expect(result.current.thread?.data.messages).toHaveLength(2));
  const combined = { ...next, data: { ...next.data, messages: [...first.data.messages, ...next.data.messages] } };
  vi.mocked(readConversationWindow).mockResolvedValueOnce(combined);
  await act(async () => { await result.current.refresh(); });
  expect(vi.mocked(readConversationWindow).mock.calls.at(-1)?.[2]).toBe(2);
  vi.mocked(readConversationWindow).mockResolvedValueOnce({ ...combined, asOfSequence: 9 });
  await act(async () => { await result.current.refresh(); });
  expect(result.current.error).toContain("SNAPSHOT_REGRESSED");
  expect(result.current.thread).toEqual(combined);
});


it("keeps an unrelated active submission and its draft visible after reconciling archived history", async () => {
  const active = savedSubmission("active B"); const old = savedSubmission("archived A");
  const historical = { ...old, status: applied(old), refreshed: true };
  const oldThread = { ...thread, data: { ...thread.data, cursor: historical.status.result.cursor } };
  vi.mocked(loadSubmission).mockResolvedValue(active);
  vi.mocked(reconcileSubmission).mockResolvedValueOnce({ submission: historical, thread: oldThread });
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.busy).toBe(false));
  const visible = { ...thread, data: { ...thread.data, messages: Array.from({ length: 101 }, () => ({}) as never) } };
  vi.mocked(getConversation).mockResolvedValueOnce(visible);
  act(() => result.current.select(id)); await waitFor(() => expect(result.current.thread?.data.messages).toHaveLength(101));
  act(() => result.current.reconcile(historical));
  await waitFor(() => expect(reconcileSubmission).toHaveBeenCalledOnce());
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.submission).toEqual(active); expect(result.current.draft).toBe("active B");
  expect(vi.mocked(reconcileSubmission).mock.calls[0]?.[3]).toBeUndefined();
  expect(submitConversation).not.toHaveBeenCalled();
});

it.each(["thread watermark", "thread cursor", "index watermark"])("retains newer visible state when send follow-up regresses its %s", async (kind) => {
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.busy).toBe(false));
  const previous = { ...thread, data: { ...thread.data, cursor: { ...cursor, sequence: 2 } } };
  vi.mocked(getConversation).mockResolvedValueOnce(previous);
  act(() => result.current.select(id)); await waitFor(() => expect(result.current.thread).toEqual(previous));
  const earlier = kind === "thread cursor" ? thread : kind === "thread watermark" ? { ...previous, asOfSequence: 9 } : previous;
  vi.mocked(submitConversation).mockResolvedValueOnce({ submission: savedSubmission("accepted"), thread: earlier });
  if (kind === "index watermark") vi.mocked(readConversationIndexWindow).mockResolvedValueOnce({ ...result.current.index!, asOfSequence: 9 });
  act(() => result.current.setDraft("accepted")); act(() => result.current.send());
  await waitFor(() => expect(result.current.error).toContain("SNAPSHOT_REGRESSED"));
  expect(result.current.thread).toEqual(previous); expect(result.current.index?.asOfSequence).toBe(10);
});

it("preserves an explicit New conversation selection and draft across ordinary refresh", async () => {
  const row = savedSubmission("completed"); const completed = { ...row, status: applied(row), refreshed: true };
  vi.mocked(loadSubmission).mockResolvedValue(completed);
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.selected).toBe(completed.status.result.cursor.conversation_id));
  act(() => result.current.select(null)); act(() => result.current.setDraft("a new goal"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current).toMatchObject({ selected: null, thread: null, draft: "a new goal" });
});

it("retains same-owner draft and displayed data on a refusal older than a validated selection", async () => {
  const { result } = renderHook(() => useConversation(true));
  await waitFor(() => expect(result.current.busy).toBe(false));
  act(() => result.current.setDraft("new text")); const index = result.current.index;
  const response = deferred<NonNullable<typeof index>>();
  vi.mocked(readConversationIndexWindow).mockReturnValueOnce(response.promise);
  let refresh!: Promise<number | null>;
  act(() => { refresh = result.current.refresh(); });
  await waitFor(() => expect(readConversationIndexWindow).toHaveBeenCalledTimes(2));
  await discoverOwner();
  await act(async () => { response.reject(new ApiError("GET", "/conversations", 401, "old refusal")); await refresh; });
  expect(csrfToken()).toBe("original"); expect(result.current.draft).toBe("new text");
  expect(result.current.index).toEqual(index); expect(result.current.owner).not.toBeNull();
});
