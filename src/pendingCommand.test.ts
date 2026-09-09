import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingCommand,
  envelopeForRetryOrCreate,
  loadPendingCommand,
  pendingConflicts,
  persistPendingCommand,
  rememberAdmittedCommand,
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

afterEach(() => {
  clearPendingCommand();
});

describe("pending command envelope custody", () => {
  it("persists the envelope before any caller may POST", () => {
    persistPendingCommand({ envelope: first, commandId: null });
    expect(loadPendingCommand()).toEqual({ envelope: first, commandId: null });
  });

  it("reuses the stored key instead of minting a new one after lost admission", () => {
    persistPendingCommand({ envelope: first, commandId: null });
    expect(envelopeForRetryOrCreate(() => second)).toEqual(first);
    expect(loadPendingCommand()?.envelope.idempotency_key).toBe("portal_first");
  });

  it("refuses a different kind or payload while a pending envelope exists", () => {
    persistPendingCommand({ envelope: first, commandId: null });
    expect(
      pendingConflicts({ idempotency_key: "portal_other", kind: "run_coding", payload: {} }),
    ).toBe(true);
    expect(pendingConflicts(second)).toBe(false);
  });

  it("records the admitted command id without changing the envelope", () => {
    persistPendingCommand({ envelope: first, commandId: null });
    rememberAdmittedCommand("cmd_admitted");
    expect(loadPendingCommand()).toEqual({
      envelope: first,
      commandId: "cmd_admitted",
    });
  });
});
