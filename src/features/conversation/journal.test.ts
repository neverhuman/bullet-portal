import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetBrowserSession, rememberCsrfToken } from "../../apiSession";
import { prepareCommand } from "../../commandIdentity";
import { conversationEnvelope } from "./contracts";
import { archiveSubmission, effectiveStatus, envelopeOf, listSubmissionObservations, listSubmissions,
  loadSubmission, recordStatus, reserveSubmission, type Submission } from "./journal";
import { applied, database, storage, write } from "./fixture.test-support";

let owner: ReturnType<typeof storage>;
beforeEach(() => { owner = storage(); });
afterEach(() => { forgetBrowserSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const envelope = (text = "original message") => conversationEnvelope(text, null);
const terminal = (row: Submission, status: "UNKNOWN" | "FAILED" | "PENDING" = "UNKNOWN") => ({
  ...prepareCommand(envelopeOf(row)).subject, status, result: status === "PENDING" ? null : {},
});

it("commits exact request and draft identity before returning, and retains completion across reopen", async () => {
  expect(await loadSubmission(owner)).toBeNull();
  const request = envelope(); const row = await reserveSubmission(owner, request, "draft");
  expect(row.body).toBe(JSON.stringify({ idempotency_key: request.idempotency_key, kind: "conversation_message",
    payload: { content: "original message", cursor: null, schema_version: "bullet.conversation-message.v1" } }));
  expect(await loadSubmission(owner)).toEqual(row);
  expect(JSON.stringify(row)).not.toContain("synthetic-secret");
  const settled = await recordStatus(owner, row, applied(row), true);
  expect(await loadSubmission(owner)).toEqual(settled);
  expect(await reserveSubmission(owner, envelope(), "draft")).toEqual(settled);
  expect((await reserveSubmission(owner, envelope("intentional next"), "next")).id).not.toBe(row.id);
});

it("reserves exactly one of two competing drafts without aliasing the losing draft", async () => {
  const results = await Promise.allSettled([reserveSubmission(owner, envelope("one"), "one"),
    reserveSubmission(owner, envelope("two"), "two")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: expect.objectContaining({ message: expect.stringContaining("JOURNAL_CONFLICT") }),
  });
  expect(await listSubmissions(owner)).toHaveLength(1);
});

it("archives only the exact terminal request and preserves its unresolved history", async () => {
  const row = await reserveSubmission(owner, envelope());
  await expect(archiveSubmission(owner, row)).rejects.toThrow("ARCHIVE_REFUSED");
  const pending = await recordStatus(owner, row, terminal(row, "PENDING"));
  await expect(archiveSubmission(owner, pending)).rejects.toThrow("ARCHIVE_REFUSED");
  const failed = await recordStatus(owner, pending, terminal(row, "FAILED"));
  await expect(archiveSubmission(owner, { ...failed, body: "{}" })).rejects.toThrow("ARCHIVE_REFUSED");
  await archiveSubmission(owner, failed);
  expect(await loadSubmission(owner)).toBeNull();
  expect(await listSubmissions(owner)).toEqual([failed]);
  expect(await reserveSubmission(owner, envelope(), failed.draftRevision)).toEqual(failed);
});

it("preserves terminal receipts and appends reconciliation contradictions without adopting regressions", async () => {
  const original = await reserveSubmission(owner, envelope());
  const unknown = await recordStatus(owner, original, terminal(original));
  const recovered = await recordStatus(owner, unknown, applied(original), true, true);
  expect(recovered.status).toEqual(terminal(original));
  expect(effectiveStatus(recovered)).toEqual(applied(original));
  await expect(recordStatus(owner, unknown, terminal(original, "FAILED"), false, true)).rejects.toThrow("CONTRADICTION");
  expect(await loadSubmission(owner)).toEqual(recovered);
  expect((await listSubmissionObservations(owner, original)).map((row) => row.status.status)).toEqual(["UNKNOWN", "APPLIED", "FAILED"]);
  expect(await recordStatus(owner, original, applied(original))).toEqual(recovered);
});

it("does not let a historical settlement remove another draft reservation", async () => {
  const first = await reserveSubmission(owner, envelope("first"));
  const unknown = await recordStatus(owner, first, terminal(first)); await archiveSubmission(owner, unknown);
  const second = await reserveSubmission(owner, envelope("second"));
  await recordStatus(owner, unknown, applied(first), true, true);
  expect(await loadSubmission(owner)).toEqual(second);
});

it("partitions saved rows by operator and rejects a changed authentication epoch", async () => {
  const row = await reserveSubmission(owner, envelope());
  const other = { ...owner, operatorId: `opr_${"9".repeat(64)}` };
  expect(await loadSubmission(other)).toBeNull(); expect(await listSubmissions(other)).toEqual([]);
  await expect(recordStatus(other, row, applied(row))).rejects.toThrow("JOURNAL_INVALID");
  rememberCsrfToken("replacement");
  await expect(loadSubmission(owner)).rejects.toThrow("OWNER_CHANGED");
});

it.each([1, 2])("migrates legacy v%s pending bytes and records a durable completion mapping", async (version) => {
  const request = envelope(); const prepared = prepareCommand(request);
  const row: Submission = { schema: 1, origin: owner.origin, operatorId: owner.operatorId,
    destination: "/api/v1/commands", id: prepared.subject.id, body: prepared.body, status: null, refreshed: false };
  const db = await database(version);
  await write(db, "submissions", [owner.origin, owner.operatorId, row.id], row);
  await write(db, "pending", [owner.origin, owner.operatorId], row.id); db.close();
  const restored = (await loadSubmission(owner))!;
  await recordStatus(owner, restored, applied(row), true);
  expect((await reserveSubmission(owner, request)).id).toBe(row.id);
  expect((await loadSubmission(owner))?.refreshed).toBe(true);
});

it("aborts all reservation writes if storage fails mid-transaction", async () => {
  const add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === "pending") throw new DOMException("full", "QuotaExceededError");
    return add.call(this, value, key);
  });
  await expect(reserveSubmission(owner, envelope())).rejects.toThrow("full");
  expect(await listSubmissions(owner)).toEqual([]); expect(await loadSubmission(owner)).toBeNull();
});

it("fails closed when IndexedDB is unavailable or cannot open", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(loadSubmission(owner)).rejects.toThrow("JOURNAL_UNAVAILABLE");
  vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("denied", "SecurityError"); } });
  await expect(loadSubmission(owner)).rejects.toThrow("denied");
});

it("rejects corrupted pointers and request subjects instead of treating history as empty", async () => {
  const row = await reserveSubmission(owner, envelope()); const db = await database();
  await write(db, "pending", [owner.origin, owner.operatorId], 123);
  await expect(loadSubmission(owner)).rejects.toThrow("JOURNAL_INVALID");
  await write(db, "pending", [owner.origin, owner.operatorId], row.id);
  for (const changed of [{ ...row, schema: 2 }, { ...row, destination: "https://elsewhere.invalid" },
    { ...row, refreshed: true }, { ...row, status: undefined }, { ...row, reconciledStatus: null }, { ...row, draftRevision: "" }, { ...row, body: "{}" },
    { ...row, status: { ...applied(row), id: `cmd_${"9".repeat(64)}` } }]) {
    await write(db, "submissions", [owner.origin, owner.operatorId, row.id], changed);
    await expect(loadSubmission(owner)).rejects.toThrow();
  }
  db.close();
});

it("returns bounded history pages with an exclusive durable continuation", async () => {
  await loadSubmission(owner); const db = await database();
  const rows: Submission[] = [];
  for (let i = 0; i < 101; i += 1) {
    const request = envelope(String(i)); const prepared = prepareCommand(request);
    const row: Submission = { schema: 1, origin: owner.origin, operatorId: owner.operatorId,
      destination: "/api/v1/commands", id: prepared.subject.id, body: prepared.body, status: null, refreshed: false };
    rows.push(row); await write(db, "submissions", [owner.origin, owner.operatorId, row.id], row);
  }
  db.close();
  const first = await listSubmissions(owner); const last = await listSubmissions(owner, first.at(-1)!.id);
  expect(first).toHaveLength(100); expect(last).toHaveLength(1);
  expect(new Set([...first, ...last].map((row) => row.id))).toEqual(new Set(rows.map((row) => row.id)));
});
