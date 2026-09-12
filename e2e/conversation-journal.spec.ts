import { expect, test, type Page } from "@playwright/test";
import type { Submission } from "../src/features/conversation/journal";
import type { ConversationOwner } from "../src/features/conversation/owner";
import type { CommandStatus } from "../src/generated/api";

declare global {
  interface Window {
    journalFixture: {
      journal: typeof import("../src/features/conversation/journal");
      contracts: typeof import("../src/features/conversation/contracts");
      talk: typeof import("../src/features/conversation/talk");
      session: typeof import("../src/apiSession");
      identity: typeof import("../src/commandIdentity");
      owner: ConversationOwner;
      status: (row: Submission, status?: CommandStatus["status"]) => CommandStatus;
    };
  }
}

async function fixture(page: Page): Promise<void> {
  // Serve a blank document on the Vite origin: no application auth or SSE can
  // interfere with the isolated journal. The production modules run unchanged.
  await page.route("**/journal-fixture", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Journal component qualification</title>",
  }));
  await page.goto("/journal-fixture");
  await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const journal = await load("/src/features/conversation/journal.ts");
    const contracts = await load("/src/features/conversation/contracts.ts");
    const talk = await load("/src/features/conversation/talk.ts");
    const session = await load("/src/apiSession.ts");
    const identity = await load("/src/commandIdentity.ts");
    session.rememberCsrfToken("synthetic-private-token");
    const owner = { origin: location.origin, operatorId: `opr_${"1".repeat(64)}`,
      sessionId: `sid_${"2".repeat(64)}`, epoch: session.browserSessionEpoch(), csrf: session.csrfToken() };
    window.journalFixture = { journal, contracts, talk, session, identity, owner,
      status(row, status = "APPLIED") {
        const envelope = journal.envelopeOf(row);
        const payload = contracts.payloadOf(envelope);
        const mid = contracts.messageId(row.id);
        return { ...identity.prepareCommand(envelope).subject, status, result: status === "APPLIED" ? {
          schema_version: "bullet.conversation-message-receipt.v1", content_digest: contracts.digest(payload.content),
          cursor: { conversation_id: payload.cursor?.conversation_id ??
            `cnv_${contracts.digest(`bullet.conversation.v1\0${owner.operatorId}\0${row.id}`)}`,
          message_id: mid, sequence: (payload.cursor?.sequence ?? 0) + 1 },
          head_turn_id: `hdt_${contracts.digest(`bullet.conversation-head-turn.v1\0${mid}`)}`,
        } : null };
      },
    };
  });
}

test.beforeEach(async ({ page }) => { await fixture(page); });

test("settlement survives reload and the same draft retains its original request", async ({ page }) => {
  const original = await page.evaluate(async () => {
    const { journal, contracts, owner, status } = window.journalFixture;
    const row = await journal.reserveSubmission(owner, contracts.conversationEnvelope("real draft bytes", null), "draft-one");
    await journal.recordStatus(owner, row, status(row), true);
    return row;
  });
  await fixture(page);
  const result = await page.evaluate(async () => {
    const { journal, contracts, owner } = window.journalFixture;
    const recovered = await journal.loadSubmission(owner);
    const retry = await journal.reserveSubmission(owner, contracts.conversationEnvelope("real draft bytes", null), "draft-one");
    const next = await journal.reserveSubmission(owner, contracts.conversationEnvelope("intentional new message", null), "draft-two");
    return { recovered, retry, next, history: await journal.listSubmissions(owner) };
  });
  expect(result.recovered).toMatchObject({ id: original.id, body: original.body, refreshed: true });
  expect(result.retry).toMatchObject({ id: original.id, body: original.body, refreshed: true });
  expect(result.next.id).not.toBe(original.id);
  expect(result.history).toHaveLength(2);
  expect(JSON.stringify(result.history)).not.toContain("synthetic-private-token");
});

test("two tabs reserve one exact request and retain it when the winning tab closes", async ({ page, context }) => {
  const second = await context.newPage(); await fixture(second);
  const reserve = (tab: Page, text: string) => tab.evaluate(async (content) => {
    const { journal, contracts, owner } = window.journalFixture;
    return journal.reserveSubmission(owner, contracts.conversationEnvelope(content, null), content)
      .then((row) => ({ row, error: null }), (error: Error) => ({ row: null, error: error.message }));
  }, text);
  const [first, other] = await Promise.all([reserve(page, "first tab"), reserve(second, "second tab")]);
  const winner = first.row ?? other.row;
  expect(winner).not.toBeNull();
  expect([first, other].filter((result) => result.row !== null)).toHaveLength(1);
  expect(first.error ?? other.error).toContain("CONVERSATION_JOURNAL_CONFLICT");
  const survivor = first.row === null ? page : second;
  await (first.row === null ? second : page).close();
  await fixture(survivor);
  const recovered = await survivor.evaluate(async () => {
    const { journal, owner } = window.journalFixture;
    return { active: await journal.loadSubmission(owner), history: await journal.listSubmissions(owner) };
  });
  expect(recovered.active).toEqual(winner);
  expect(recovered.history).toHaveLength(1);
});

test("archives only exact terminal records and preserves their draft recovery identity", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { journal, contracts, owner, status } = window.journalFixture;
    const row = await journal.reserveSubmission(owner, contracts.conversationEnvelope("unresolved", null), "unresolved-draft");
    const pending = await journal.recordStatus(owner, row, status(row, "PENDING"));
    const refused = await journal.archiveSubmission(owner, pending).then(() => "accepted", (error: Error) => error.message);
    const terminal = await journal.recordStatus(owner, pending, status(row, "UNKNOWN"));
    await journal.archiveSubmission(owner, terminal);
    const retry = await journal.reserveSubmission(owner, contracts.conversationEnvelope("unresolved", null), "unresolved-draft");
    const next = await journal.reserveSubmission(owner, contracts.conversationEnvelope("new intent", null), "new-draft");
    return { refused, terminal, retry, next, history: await journal.listSubmissions(owner) };
  });
  expect(result.refused).toContain("CONVERSATION_ARCHIVE_REFUSED");
  expect(result.retry).toEqual(result.terminal);
  expect(result.next.id).not.toBe(result.terminal.id);
  expect(result.history).toContainEqual(result.terminal);
});

test("owner changes retain private history without exposing it to another operator", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { journal, contracts, owner, session } = window.journalFixture;
    const row = await journal.reserveSubmission(owner, contracts.conversationEnvelope("private message", null));
    const other = { ...owner, operatorId: `opr_${"3".repeat(64)}` };
    const otherHistory = await journal.listSubmissions(other);
    session.rememberCsrfToken("replacement");
    const oldRefusal = await journal.loadSubmission(owner).then(() => "accepted", (error: Error) => error.message);
    const reauthenticated = { ...owner, epoch: session.browserSessionEpoch(), csrf: session.csrfToken() };
    return { row, otherHistory, oldRefusal, recovered: await journal.loadSubmission(reauthenticated) };
  });
  expect(result.otherHistory).toEqual([]);
  expect(result.oldRefusal).toContain("CONVERSATION_OWNER_CHANGED");
  expect(result.recovered).toEqual(result.row);
});

for (const version of [1, 2]) test(`version-3 migration preserves v${version} identity through direct legacy retry and settlement`, async ({ page }) => {
  const before = await page.evaluate(async (version) => {
    const { contracts, owner, identity } = window.journalFixture;
    const prepared = identity.prepareCommand(contracts.conversationEnvelope("legacy request", null));
    const row: Submission = { schema: 1, origin: owner.origin, operatorId: owner.operatorId,
      destination: "/api/v1/commands", id: prepared.subject.id, body: prepared.body, status: null, refreshed: false };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("bullet-farm.conversation-submissions.v1", version);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("submissions"); open.result.createObjectStore("pending");
        if (version === 2) { open.result.createObjectStore("drafts"); open.result.createObjectStore("completed"); }
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(["submissions", "pending"], "readwrite");
        tx.objectStore("submissions").add(row, [row.origin, row.operatorId, row.id]);
        tx.objectStore("pending").add(row.id, [row.origin, row.operatorId]);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onabort = () => reject(tx.error);
      };
    });
    return row;
  }, version);
  const result = await page.evaluate(async () => {
    const { journal, owner, status } = window.journalFixture;
    const legacy = (await journal.loadSubmission(owner))!;
    // Direct Retry calls status recording without passing through reservation.
    const settled = await journal.recordStatus(owner, legacy, status(legacy), true);
    return { legacy, settled, revision: journal.envelopeOf(legacy).idempotency_key };
  });
  expect(result.legacy).toMatchObject(before);
  expect(result.settled.draftRevision).toBe(result.revision);
  await fixture(page);
  const retried = await page.evaluate(async (revision) => {
    const { journal, contracts, owner } = window.journalFixture;
    const recovered = await journal.loadSubmission(owner);
    const retry = await journal.reserveSubmission(owner, contracts.conversationEnvelope("legacy request", null), revision);
    return { recovered, retry, history: await journal.listSubmissions(owner) };
  }, result.revision);
  expect(retried.recovered).toEqual(result.settled);
  expect(retried.retry).toEqual(result.settled);
  expect(retried.history).toHaveLength(1);
});

test("unacknowledged command absence never authorizes replay", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { journal, contracts, talk, owner } = window.journalFixture;
    const row = await journal.reserveSubmission(owner, contracts.conversationEnvelope("held request", null));
    let posts = 0;
    window.fetch = async (input, init) => {
      if (init?.method === "POST") { posts += 1; throw new Error("unexpected replay"); }
      if (String(input).endsWith("/auth/session")) return new Response(JSON.stringify({
        status: "AUTHENTICATED", operator_id: owner.operatorId, session_id: owner.sessionId,
        issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z",
      }), { headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404, headers: { "content-type": "application/problem+json" } });
    };
    const refusal = await talk.reconcileSubmission(owner, row).then(() => "accepted", (error: Error) => error.message);
    return { posts, refusal, preserved: await journal.loadSubmission(owner), row };
  });
  expect(result.posts).toBe(0);
  expect(result.refusal).toContain("SESSION_BINDING_REQUIRED");
  expect(result.preserved).toEqual(result.row);
});

test("concurrent readers adopt an identical receipt already settled by another reader", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { journal, contracts, owner, status } = window.journalFixture;
    const row = await journal.reserveSubmission(owner, contracts.conversationEnvelope("same receipt", null));
    const receipt = status(row);
    const settled = await journal.recordStatus(owner, row, receipt, true);
    const concurrent = await journal.recordStatus(owner, row, receipt, false, true);
    return { settled, concurrent, recovered: await journal.loadSubmission(owner) };
  });
  expect(result.concurrent).toEqual(result.settled);
  expect(result.recovered).toEqual(result.settled);
});

test("later reconciliation preserves the original terminal receipt and conflicting observations", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { journal, contracts, owner, status } = window.journalFixture;
    const row = await journal.reserveSubmission(owner, contracts.conversationEnvelope("ambiguous outcome", null));
    const unknown = await journal.recordStatus(owner, row, status(row, "UNKNOWN"));
    await journal.archiveSubmission(owner, unknown);
    const observed = await journal.recordStatus(owner, unknown, status(row), false, true);
    const settled = await journal.recordStatus(owner, observed, status(row), true);
    const conflict = await journal.recordStatus(owner, settled, status(row, "UNKNOWN"), false, true)
      .then(() => "accepted", (error: Error) => error.message);
    return { unknown, settled, conflict, history: await journal.listSubmissions(owner),
      observations: await journal.listSubmissionObservations(owner, row) };
  });
  expect(result.settled.status).toEqual(result.unknown.status);
  expect(result.settled).toMatchObject({ refreshed: true, reconciledStatus: { status: "APPLIED" } });
  expect(result.conflict).toContain("CONVERSATION_RECEIPT_CONTRADICTION");
  expect(result.history).toContainEqual(result.settled);
  expect(result.observations.map((row) => row.status.status)).toEqual(["UNKNOWN", "APPLIED", "APPLIED", "UNKNOWN"]);
});

test("an aborted reservation transaction leaves no partial row and cannot dispatch", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { journal, talk, owner } = window.journalFixture;
    const add = IDBObjectStore.prototype.add;
    let posts = 0;
    window.fetch = async () => { posts += 1; throw new Error("unexpected network access"); };
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === "pending") throw new DOMException("injected quota exhaustion", "QuotaExceededError");
      return add.apply(this, args);
    };
    let refusal: string;
    try {
      refusal = await talk.submitConversation(owner, "must commit before dispatch", null)
        .then(() => "accepted", (error: Error) => error.message);
    } finally { IDBObjectStore.prototype.add = add; }
    return { refusal, posts, history: await journal.listSubmissions(owner), active: await journal.loadSubmission(owner) };
  });
  expect(result.refusal).toContain("injected quota exhaustion");
  expect(result.posts).toBe(0); expect(result.history).toEqual([]); expect(result.active).toBeNull();
});
