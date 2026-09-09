import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingCommand,
  clearPendingCommandIf,
  envelopeForRetryOrCreate,
  loadPendingCommand,
  pendingConflicts,
  persistPendingCommand,
  rememberAdmittedCommand,
  restoredSubjectConflicts,
} from "./pendingCommand";

const first = {
  idempotency_key: "portal_first",
  kind: "run_demo",
  payload: {},
};
const second = {
  idempotency_key: "portal_second",
  kind: "run_demo",
  payload: {},
};
const digest = "b".repeat(64);

afterEach(() => {
  clearPendingCommand();
});

describe("pending command envelope custody", () => {
  it("persists the envelope before any caller may POST", () => {
    persistPendingCommand({
      envelope: first,
      commandId: null,
      kind: "run_demo",
      payloadDigest: null,
    });
    expect(loadPendingCommand()).toEqual({
      envelope: first,
      commandId: null,
      kind: "run_demo",
      payloadDigest: null,
    });
  });

  it("reuses the stored key instead of minting a new one after lost admission", () => {
    persistPendingCommand({
      envelope: first,
      commandId: null,
      kind: "run_demo",
      payloadDigest: null,
    });
    expect(envelopeForRetryOrCreate(() => second)).toEqual(first);
    expect(loadPendingCommand()?.envelope.idempotency_key).toBe("portal_first");
  });

  it("refuses a different kind or payload while a pending envelope exists", () => {
    persistPendingCommand({
      envelope: first,
      commandId: null,
      kind: "run_demo",
      payloadDigest: null,
    });
    expect(
      pendingConflicts({ idempotency_key: "portal_other", kind: "run_coding", payload: {} }),
    ).toBe(true);
    expect(pendingConflicts(second)).toBe(false);
  });

  it("records the admitted subject without changing the envelope", () => {
    persistPendingCommand({
      envelope: first,
      commandId: null,
      kind: "run_demo",
      payloadDigest: null,
    });
    expect(
      rememberAdmittedCommand({
        commandId: "cmd_admitted",
        kind: "run_demo",
        payloadDigest: digest,
      }),
    ).toBe(true);
    expect(loadPendingCommand()).toEqual({
      envelope: first,
      commandId: "cmd_admitted",
      kind: "run_demo",
      payloadDigest: digest,
    });
  });

  it("keeps the pre-POST envelope when admitted-id persistence fails", () => {
    persistPendingCommand({
      envelope: first,
      commandId: null,
      kind: "run_demo",
      payloadDigest: null,
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      expect(
        rememberAdmittedCommand({
          commandId: "cmd_admitted",
          kind: "run_demo",
          payloadDigest: digest,
        }),
      ).toBe(false);
    } finally {
      setItem.mockRestore();
    }
    expect(loadPendingCommand()?.envelope).toEqual(first);
    expect(loadPendingCommand()?.commandId).toBeNull();
  });

  it("clears only a matching admitted subject", () => {
    persistPendingCommand({
      envelope: first,
      commandId: "cmd_old",
      kind: "run_demo",
      payloadDigest: digest,
    });
    expect(
      clearPendingCommandIf({
        commandId: "cmd_new",
        kind: "run_demo",
        payloadDigest: digest,
      }),
    ).toBe(false);
    expect(loadPendingCommand()?.commandId).toBe("cmd_old");
    expect(
      clearPendingCommandIf({
        commandId: "cmd_old",
        kind: "run_demo",
        payloadDigest: digest,
      }),
    ).toBe(true);
    expect(loadPendingCommand()).toBeNull();
  });

  it("detects a restored GET whose kind or digest drifted", () => {
    const pending = {
      envelope: first,
      commandId: "cmd_admitted",
      kind: "run_demo",
      payloadDigest: digest,
    };
    expect(
      restoredSubjectConflicts(pending, {
        id: "cmd_admitted",
        kind: "run_coding",
        payload_digest: digest,
      }),
    ).toBe(true);
    expect(
      restoredSubjectConflicts(pending, {
        id: "cmd_admitted",
        kind: "run_demo",
        payload_digest: "c".repeat(64),
      }),
    ).toBe(true);
    expect(
      restoredSubjectConflicts(pending, {
        id: "cmd_admitted",
        kind: "run_demo",
        payload_digest: digest,
      }),
    ).toBe(false);
  });
});
