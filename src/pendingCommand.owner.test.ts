import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discoverOwner } from "./apiOwner";
import { getOperatorSession } from "./apiAuth";
import { rememberCsrfToken } from "./apiSession";
import { prepareCommand } from "./commandIdentity";
import { clearPendingCommandIf, envelopeForRetryOrCreate, loadPendingCommand, persistPendingCommand,
  recoverPendingCommand, rememberAdmittedCommand } from "./pendingCommand";
import { identity, ownerFixture, pendingSlot, setupOwner } from "./testing/pendingOwner";

vi.mock("./apiAuth", () => ({ getOperatorSession: vi.fn() }));
const envelope = { idempotency_key: "legacy-original", kind: "run_demo", payload: { private: "original bytes" } };
const subject = prepareCommand(envelope).subject;
const pending = { envelope, commandId: null, kind: envelope.kind, payloadDigest: null };
const admitted = { envelope, commandId: subject.id, kind: subject.kind, payloadDigest: subject.payload_digest };
const terminal = { ...subject, status: "UNKNOWN", result: {} };
const legacySlot = "bullet-farm.pending-command.v1";
const raw = ` { "envelope": ${JSON.stringify(envelope)}, "commandId": null } `;
function response(value: unknown = terminal, ack: string | null = identity.session_id, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": status === 200 ? "application/json" : "application/problem+json",
    ...(ack === null ? {} : { "x-bullet-session-id": ack }) } });
}
beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); setupOwner(); vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response())); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

it("keeps legacy fields private until a successful owner-bound exact read and preserves original raw bytes", async () => {
  sessionStorage.setItem(legacySlot, raw);
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const owner = await discoverOwner(); const recovering = recoverPendingCommand(owner);
  expect(() => loadPendingCommand(owner)).toThrow("ownership unresolved");
  expect(sessionStorage.getItem(pendingSlot())).toBeNull();
  expect(fetch).toHaveBeenCalledWith(`/api/v1/commands/${subject.id}`, expect.objectContaining({
    credentials: "same-origin", headers: { "x-bullet-expected-session": owner.sessionId } }));
  finish(response()); expect(await recovering).toEqual(admitted);
  const stored = JSON.parse(sessionStorage.getItem(pendingSlot())!);
  expect(stored.legacyRaw).toBe(raw); expect(stored.requestBody).toBe(prepareCommand(envelope).body);
  expect(stored).not.toHaveProperty("csrf"); expect(stored).not.toHaveProperty("sessionId");
  expect(sessionStorage.getItem(legacySlot)).toBeNull();
  expect(clearPendingCommandIf({ commandId: subject.id, kind: subject.kind, payloadDigest: subject.payload_digest }, envelope, owner)).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(`${pendingSlot()}:history:${subject.id}`)!).legacyRaw).toBe(raw);
});

it.each(["missing acknowledgement", "wrong acknowledgement", "wrong subject", "owned absence", "unauthorized"])(
  "retains legacy bytes and never adopts or posts after %s", async (failure) => {
    sessionStorage.setItem(legacySlot, raw);
    const owner = await discoverOwner();
    const problem = { type: "https://bullet.farm/problems/not-found", title: "Not found", status: failure === "unauthorized" ? 401 : 404,
      detail: "not available", instance: "urn:bullet:request:req_deadbeefdeadbeef", code: "NOT_FOUND", request_id: "req_deadbeefdeadbeef", correlation_id: "corr_deadbeefdeadbeef", retryable: false, repair: "reconcile" };
    vi.mocked(fetch).mockResolvedValueOnce(failure === "missing acknowledgement" ? response(terminal, null)
      : failure === "wrong acknowledgement" ? response(terminal, `sid_${"3".repeat(64)}`)
      : failure === "wrong subject" ? response({ ...terminal, payload_digest: "a".repeat(64) })
      : response(problem, identity.session_id, problem.status));
    await expect(recoverPendingCommand(owner)).rejects.toThrow("ownership unresolved");
    expect(sessionStorage.getItem(legacySlot)).toBe(raw); expect(sessionStorage.getItem(pendingSlot())).toBeNull();
    expect(fetch).toHaveBeenCalledOnce(); expect(vi.mocked(fetch).mock.calls[0][1]?.method ?? "GET").toBe("GET");
  });

it("refuses late owner-switch adoption and retains the original bytes", async () => {
  sessionStorage.setItem(legacySlot, raw);
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const owner = await discoverOwner(); const recovery = recoverPendingCommand(owner);
  const refusal = expect(recovery).rejects.toThrow("ownership unresolved");
  rememberCsrfToken("other-owner"); finish(response()); await refusal;
  expect(sessionStorage.getItem(legacySlot)).toBe(raw); expect(sessionStorage.getItem(pendingSlot())).toBeNull();
});

it("retains legacy custody on migration write failure and preserves both copies on removal failure", async () => {
  sessionStorage.setItem(legacySlot, raw); const owner = await discoverOwner();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disk full"); });
  await expect(recoverPendingCommand(owner)).rejects.toThrow("ownership unresolved");
  write.mockRestore(); expect(sessionStorage.getItem(legacySlot)).toBe(raw);
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
  await expect(recoverPendingCommand(owner)).rejects.toThrow("ownership unresolved"); remove.mockRestore();
  expect(sessionStorage.getItem(legacySlot)).toBe(raw);
  expect(JSON.parse(sessionStorage.getItem(pendingSlot())!).legacyRaw).toBe(raw);
  expect(await recoverPendingCommand(owner)).toEqual(admitted);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("partitions owners, permits same-owner reauthentication and rejects stale admission/clear", async () => {
  const a = await discoverOwner(); persistPendingCommand(pending, a);
  const original = sessionStorage.getItem(pendingSlot());
  rememberCsrfToken("owner-b");
  vi.mocked(getOperatorSession).mockResolvedValue({ status: "AUTHENTICATED", operator_id: `opr_${"3".repeat(64)}`,
    session_id: `sid_${"4".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" });
  const b = await discoverOwner(); expect(loadPendingCommand(b)).toBeNull();
  expect(() => rememberAdmittedCommand(admitted, envelope, a)).toThrow();
  expect(() => clearPendingCommandIf(admitted, envelope, a)).toThrow();
  expect(sessionStorage.getItem(pendingSlot())).toBe(original);
  setupOwner(); const renewed = await discoverOwner();
  expect(envelopeForRetryOrCreate(() => { throw new Error("must not mint"); }, renewed)).toEqual(envelope);
  expect(rememberAdmittedCommand(admitted, envelope, renewed)).toBe(true);
  expect(() => persistPendingCommand(pending, renewed)).toThrow("cannot move backwards");
  expect(loadPendingCommand(renewed)).toEqual(admitted);
});

it("refuses a migration conflict introduced while its exact read is pending", async () => {
  sessionStorage.setItem(legacySlot, raw); const owner = await discoverOwner();
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const recovery = recoverPendingCommand(owner);
  sessionStorage.removeItem(legacySlot);
  const other = { ...pending, envelope: { ...envelope, idempotency_key: "intentional-other" } };
  persistPendingCommand(other, ownerFixture()); sessionStorage.setItem(legacySlot, raw);
  finish(response()); await expect(recovery).rejects.toThrow("ownership unresolved");
  expect(loadPendingCommand(owner)).toEqual(other); expect(sessionStorage.getItem(legacySlot)).toBe(raw);
});
