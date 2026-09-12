import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getOperatorSession } from "../../apiAuth";
import { csrfToken, forgetBrowserSession, rememberCsrfToken } from "../../apiSession";
import { discoverOwner, type ConversationOwner } from "./owner";
import { conversationEnvelope, digest, messageId } from "./contracts";
import { envelopeOf, loadSubmission, recordStatus, reserveSubmission } from "./journal";
import { getConversation, listConversations, readConversationIndexWindow, readConversationWindow,
  reconcileSubmission, submitConversation } from "./talk";
import { applied, json, session, snapshot, storage, thread } from "./fixture.test-support";

vi.mock("../../apiAuth", () => ({ getOperatorSession: vi.fn() }));
let owner: ConversationOwner;
beforeEach(async () => { storage(); vi.mocked(getOperatorSession).mockResolvedValue(session); owner = await discoverOwner(); });
afterEach(() => { forgetBrowserSession(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

function absence(acknowledged = true): Response {
  return new Response(JSON.stringify({ type: "https://bullet.farm/problems/not-found", title: "Not found", status: 404, detail: "No command",
    instance: "urn:bullet:request:req_deadbeefdeadbeef", code: "NOT_FOUND", request_id: "req_deadbeefdeadbeef",
    correlation_id: "corr_deadbeefdeadbeef", retryable: false, repair: "Reconcile exact identity." }), {
    status: 404, headers: { "content-type": "application/problem+json", ...(acknowledged ? { "x-bullet-session-id": session.session_id } : {}) },
  });
}

it("dispatches only after committed reservation and settles through exact bounded readback", async () => {
  let posted = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const row = (await loadSubmission(owner))!;
    if (init.method === "POST") {
      posted += 1; expect(init.body).toBe(row.body); return json(applied(row), 202);
    }
    if (url.includes("/commands/")) return absence();
    return snapshot(thread(row));
  });
  vi.stubGlobal("fetch", fetch);
  const result = await submitConversation(owner, "durable message", null, undefined, "draft");
  expect(result.submission.refreshed).toBe(true); expect(posted).toBe(1);
  expect(result.thread.data.messages[0]?.content).toBe("durable message");
  expect(fetch.mock.calls.filter(([url]) => url.includes("/conversations/"))).toHaveLength(2);
  expect((await loadSubmission(owner))?.id).toBe(result.submission.id);
});

it("recovers a lost POST response through reads without minting or replaying a second command", async () => {
  let accepted = false; let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const row = (await loadSubmission(owner))!;
    if (init.method === "POST") { posts += 1; accepted = true; throw new TypeError("response lost after commit"); }
    if (url.includes("/commands/")) return accepted ? json(applied(row)) : absence();
    return snapshot(thread(row));
  }));
  await expect(submitConversation(owner, "once", null, undefined, "draft")).rejects.toMatchObject({ outcomeUnknown: true });
  const saved = (await loadSubmission(owner))!;
  const recovered = await reconcileSubmission(owner, saved);
  expect(recovered.submission.id).toBe(saved.id); expect(recovered.submission.body).toBe(saved.body);
  expect(recovered.submission.refreshed).toBe(true); expect(posts).toBe(1);
});

it("refuses unacknowledged absence and never replays a known terminal failure", async () => {
  const row = await reserveSubmission(owner, conversationEnvelope("unknown", null));
  const fetch = vi.fn().mockResolvedValueOnce(absence(false)); vi.stubGlobal("fetch", fetch);
  await expect(reconcileSubmission(owner, row)).rejects.toThrow("SESSION_BINDING_REQUIRED");
  const failed = await recordStatus(owner, row, { ...applied(row), status: "FAILED", result: {} });
  fetch.mockResolvedValueOnce(absence());
  await expect(reconcileSubmission(owner, failed)).rejects.toMatchObject({ status: 404 });
  expect(fetch.mock.calls.every(([, init]) => init.method !== "POST")).toBe(true);
});

it.each([401, 403])("invalidates shared auth on current command read refusal after renewal (%s)", async (status) => {
  const row = await reserveSubmission(owner, conversationEnvelope("private", null));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("refused", { status })));
  await expect(reconcileSubmission(owner, row)).rejects.toMatchObject({ status });
  expect(csrfToken()).toBeNull();
  rememberCsrfToken("reauthenticated"); const current = await discoverOwner();
  expect((await loadSubmission(current))?.body).toBe(row.body);
});

it("invalidates auth on renewed receipt read refusal and retains unresolved recovery", async () => {
  const row = await reserveSubmission(owner, conversationEnvelope("private", null));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(applied(row)))
    .mockResolvedValueOnce(new Response("refused", { status: 403 })));
  await expect(reconcileSubmission(owner, row)).rejects.toMatchObject({ status: 403 });
  expect(csrfToken()).toBeNull();
});

it("does not clear a newer selection when an older renewed read is refused", async () => {
  const row = await reserveSubmission(owner, conversationEnvelope("private", null));
  vi.stubGlobal("fetch", vi.fn(async () => {
    await discoverOwner(); return new Response("old refusal", { status: 401 });
  }));
  await expect(reconcileSubmission(owner, row)).rejects.toMatchObject({ status: 401 });
  expect(csrfToken()).toBe("synthetic-secret");
});

it("settles a message beyond sequence10000 using its exact range before refreshing a bounded window", async () => {
  const cursor = { conversation_id: `cnv_${"3".repeat(64)}`, message_id: `msg_${"4".repeat(64)}`, sequence: 10_000 };
  const row = await reserveSubmission(owner, conversationEnvelope("later", cursor));
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/commands/")) return json(applied(row), 200, 20_000);
    if (url.includes("after=10000")) return snapshot(thread(row), 20_000);
    expect((await loadSubmission(owner))?.refreshed).toBe(true);
    throw new Error("visible refresh unavailable");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(reconcileSubmission(owner, row)).rejects.toThrow("visible refresh unavailable");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/v1/commands/${row.id}`, `/api/v1/conversations/${cursor.conversation_id}?after=10000&limit=100`,
    `/api/v1/conversations/${cursor.conversation_id}?after=0&limit=100`,
  ]);
  expect((await loadSubmission(owner))?.refreshed).toBe(true);
});

it("polls a pending receipt and preserves its identity through settlement", async () => {
  const row = await reserveSubmission(owner, conversationEnvelope("queued", null));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ ...applied(row), status: "PENDING", result: null }))
    .mockResolvedValueOnce(json(applied(row))).mockImplementation(async () => snapshot(thread(row))));
  expect((await reconcileSubmission(owner, row)).submission.refreshed).toBe(true);
});

it("requires matching human bytes for the reserved draft and matching owner before recovery", async () => {
  const row = await reserveSubmission(owner, conversationEnvelope("original", null), "draft");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(submitConversation(owner, "different", null, undefined, "draft")).rejects.toThrow("JOURNAL_CONFLICT");
  await expect(reconcileSubmission({ ...owner, operatorId: `opr_${"9".repeat(64)}` }, row)).rejects.toThrow("OWNER_CHANGED");
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects regressing or duplicate conversation index pages while preserving bounded requests", async () => {
  const cursor = { conversation_id: `cnv_${"3".repeat(64)}`, message_id: `msg_${"4".repeat(64)}`, sequence: 1 };
  const entry = { cursor, preview: "message", created_at: session.issued_at, last_activity_at: session.issued_at };
  const first = { conversations: [entry], next_after: 1 };
  for (const sequence of [99, 101]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(snapshot(first)).mockResolvedValueOnce(snapshot({ conversations: [entry], next_after: null }, sequence)));
    await expect(readConversationIndexWindow(owner, 2)).rejects.toThrow("INDEX_CHANGED");
  }
  const fetch = vi.fn().mockResolvedValueOnce(snapshot(first)).mockResolvedValueOnce(snapshot({ conversations: [{ ...entry,
    cursor: { ...cursor, conversation_id: `cnv_${"5".repeat(64)}` } }], next_after: null }));
  vi.stubGlobal("fetch", fetch);
  expect((await readConversationIndexWindow(owner, 2)).data.conversations).toHaveLength(2);
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/v1/conversations?after=1&limit=100");
});

it("joins message pages only with advancing watermark and exact parent continuity", async () => {
  const one = await reserveSubmission(owner, conversationEnvelope("one", null)); const first = thread(one);
  const command = `cmd_${"9".repeat(64)}`; const mid = messageId(command);
  const cursor = { ...first.cursor, sequence: 2, message_id: mid };
  const second = { cursor, messages: [{ ...first.messages[0]!, cursor, parent_message_id: first.cursor.message_id,
    command_id: command, content: "two", content_digest: digest("two"), head_turn_id: `hdt_${digest(`bullet.conversation-head-turn.v1\0${mid}`)}` }],
    next_after: null, head_blocker: first.head_blocker };
  for (const sequence of [99, 101]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(snapshot({ ...first, cursor, next_after: 1 }))
      .mockResolvedValueOnce(snapshot(second, sequence)));
    const request = readConversationWindow(owner, cursor.conversation_id, 2);
    if (sequence === 99) await expect(request).rejects.toThrow("SNAPSHOT_REGRESSED");
    else expect((await request).data.messages.map((row) => row.content)).toEqual(["one", "two"]);
  }
});

it("refuses missing parent chains and index continuations beyond authoritative watermark", async () => {
  const row = await reserveSubmission(owner, conversationEnvelope("one", null));
  const view = thread(row);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(snapshot({ conversations: [{ cursor: view.cursor, preview: "one",
    created_at: session.issued_at, last_activity_at: session.issued_at }], next_after: 101 })));
  await expect(listConversations(owner)).rejects.toThrow("INDEX_INVALID");
  await expect(getConversation(owner, "invalid")).rejects.toThrow("invalid thread");
  expect(envelopeOf(row).payload).toMatchObject({ content: "one" });
});


it.each(["watermark", "cursor"])("keeps durable settlement but refuses a regressing visible %s after exact receipt read-back", async (kind) => {
  const row = await reserveSubmission(owner, conversationEnvelope("settled", null));
  const seen = thread(row);
  const observed = kind === "cursor" ? { ...seen, cursor: { ...seen.cursor, sequence: 2, message_id: `msg_${"5".repeat(64)}` }, next_after: 1 } : seen;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(applied(row)))
    .mockResolvedValueOnce(snapshot(observed, 100)).mockResolvedValueOnce(snapshot(seen, kind === "watermark" ? 99 : 100)));
  await expect(reconcileSubmission(owner, row)).rejects.toThrow("SNAPSHOT_REGRESSED");
  expect((await loadSubmission(owner))?.refreshed).toBe(true);
  expect((await loadSubmission(owner))?.id).toBe(row.id);
});
