import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingCommand, clearPendingCommandIf, envelopeForRetryOrCreate,
  loadPendingCommand, pendingConflicts, persistPendingCommand,
  rememberAdmittedCommand, restoredSubjectConflicts,
} from "./pendingCommand";

const first = { idempotency_key: "portal_first", kind: "run_demo", payload: {} };
const second = { ...first, idempotency_key: "portal_second" };
const digest = "b".repeat(64);
const subject = { commandId: "cmd_admitted", kind: "run_demo", payloadDigest: digest };
const pending = { envelope: first, commandId: null, kind: "run_demo", payloadDigest: null };
const slot = "bullet-farm.pending-command.v1";

afterEach(() => {
  vi.restoreAllMocks();
  clearPendingCommand();
});

describe("pending command envelope custody", () => {
  it("persists the envelope before any caller may POST", () => {
    persistPendingCommand(pending);
    expect(loadPendingCommand()).toEqual(pending);
  });

  it("reuses the stored key instead of minting a new one after lost admission", () => {
    persistPendingCommand(pending);
    expect(envelopeForRetryOrCreate(() => second)).toEqual(first);
    expect(loadPendingCommand()?.envelope.idempotency_key).toBe("portal_first");
  });

  it("refuses a different kind or payload while a pending envelope exists", () => {
    persistPendingCommand(pending);
    expect(pendingConflicts({ kind: "run_coding", payload: {} })).toBe(true);
    expect(pendingConflicts({ kind: "run_demo", payload: { other: true } })).toBe(true);
    expect(pendingConflicts(second)).toBe(false);
  });

  it("records the admitted subject without changing the envelope", () => {
    persistPendingCommand(pending);
    expect(rememberAdmittedCommand(subject, first)).toBe(true);
    expect(loadPendingCommand()).toEqual({ envelope: first, ...subject });
  });

  it("keeps the pre-POST envelope when admitted-id persistence fails", () => {
    persistPendingCommand(pending);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(rememberAdmittedCommand(subject, first)).toBe(false);
    setItem.mockRestore();
    expect(loadPendingCommand()).toEqual(pending);
  });

  it("clears only a matching admitted subject", () => {
    persistPendingCommand({ envelope: first, ...subject });
    expect(clearPendingCommandIf({ ...subject, commandId: "cmd_other" }, first)).toBe(false);
    expect(clearPendingCommandIf(subject, second)).toBe(false);
    expect(loadPendingCommand()).toEqual({ envelope: first, ...subject });
    expect(clearPendingCommandIf(subject, first)).toBe(true);
    expect(loadPendingCommand()).toBeNull();
  });

  it("detects a restored GET whose kind or digest drifted", () => {
    const stored = { envelope: first, ...subject };
    const observed = { id: subject.commandId, kind: subject.kind, payload_digest: digest };
    expect(restoredSubjectConflicts(stored, { ...observed, kind: "run_coding" })).toBe(true);
    expect(restoredSubjectConflicts(stored, { ...observed, payload_digest: "c".repeat(64) })).toBe(true);
    expect(restoredSubjectConflicts(stored, observed)).toBe(false);
  });

  it.each([
    ["malformed JSON", "{"],
    ["missing envelope", JSON.stringify({ commandId: null })],
    ["array payload", JSON.stringify({ ...pending, envelope: { ...first, payload: [] } })],
    ["legacy admitted record", JSON.stringify({ envelope: first, commandId: subject.commandId })],
    ["missing digest", JSON.stringify({ envelope: first, ...subject, payloadDigest: null })],
    ["invalid command ID", JSON.stringify({ envelope: first, ...subject, commandId: 42 })],
    ["conflicting stored kind", JSON.stringify({ envelope: first, ...subject, kind: "run_coding" })],
  ])("retains %s and refuses a fresh key", (_label, raw) => {
    sessionStorage.setItem(slot, raw);
    const create = vi.fn(() => second);
    expect(() => envelopeForRetryOrCreate(create)).toThrow("pending command storage");
    expect(create).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(slot)).toBe(raw);
  });

  it("retains unreadable storage and refuses a fresh key", () => {
    persistPendingCommand(pending);
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const create = vi.fn(() => second);
    expect(() => envelopeForRetryOrCreate(create)).toThrow("pending command storage");
    expect(create).not.toHaveBeenCalled();
    getItem.mockRestore();
    expect(loadPendingCommand()).toEqual(pending);
  });

  it("preserves a legacy envelope-only retry and creates only when absent", () => {
    sessionStorage.setItem(slot, JSON.stringify({ envelope: first, commandId: null }));
    const create = vi.fn(() => second);
    expect(envelopeForRetryOrCreate(create)).toEqual(first);
    expect(create).not.toHaveBeenCalled();
    clearPendingCommand();
    expect(envelopeForRetryOrCreate(create)).toEqual(second);
    expect(create).toHaveBeenCalledOnce();
  });

  it("refuses an old admission write into a newer envelope", () => {
    persistPendingCommand({ ...pending, envelope: second });
    expect(rememberAdmittedCommand(subject, first)).toBe(false);
    expect(loadPendingCommand()).toEqual({ ...pending, envelope: second });
    expect(rememberAdmittedCommand(subject, second)).toBe(true);
    expect(loadPendingCommand()).toEqual({ envelope: second, ...subject });
  });

  it("does not report removal when storage refuses it", () => {
    persistPendingCommand({ envelope: first, ...subject });
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => clearPendingCommandIf(subject, first)).toThrow("removal failed");
    remove.mockRestore();
    expect(loadPendingCommand()).toEqual({ envelope: first, ...subject });
  });
});
