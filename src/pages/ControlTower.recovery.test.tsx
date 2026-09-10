import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { prepareCommand } from "../commandIdentity";
import { clearPendingCommand, loadPendingCommand, persistPendingCommand } from "../pendingCommand";
import { codingPayload } from "../testing/commands";
import { operatorSnapshotFixture } from "../testing/operatorSnapshot";
import { ControlTower } from "./ControlTower";

vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  fetchOperatorSnapshot: vi.fn(), fetchHealth: vi.fn(), hasSessionMaterial: vi.fn(),
  getCommand: vi.fn(), submitCommand: vi.fn(), newRunCodingEnvelope: vi.fn(), forgetBrowserSession: vi.fn(),
}));

const envelope = { idempotency_key: "restored-cursor", kind: "run_coding", payload: {
  ...codingPayload, account_id: "acct-cursor-saved", provider: "cursor", model: "saved-model",
} };
const subject = prepareCommand(envelope).subject;
const terminal = { ...subject, status: "UNKNOWN" as const, result: {} };
const admitted = { envelope, commandId: subject.id, kind: subject.kind, payloadDigest: subject.payload_digest };

beforeEach(() => {
  vi.clearAllMocks(); clearPendingCommand();
  vi.mocked(api.hasSessionMaterial).mockReturnValue(true);
  vi.mocked(api.fetchHealth).mockResolvedValue({ status: "ok" });
  vi.mocked(api.fetchOperatorSnapshot).mockResolvedValue({ data: operatorSnapshotFixture(),
    asOfSequence: 0, observedAt: "2026-09-10T03:00:00Z", source: "bullet-kernel/sqlite-ledger" });
  vi.mocked(api.getCommand).mockResolvedValue(terminal);
  vi.mocked(api.submitCommand).mockResolvedValue(terminal);
});
afterEach(() => { cleanup(); clearPendingCommand(); });

it("reconciles a recorded admission after reload regardless of new form defaults", async () => {
  persistPendingCommand(admitted);
  render(<ControlTower />);
  await waitFor(() => expect(api.getCommand).toHaveBeenCalledExactlyOnceWith(subject.id));
  expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved");
  expect(screen.getByLabelText("Model")).toHaveValue("saved-model");
  expect(screen.getByLabelText("Provider")).toHaveValue("cursor");
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
  expect(api.submitCommand).not.toHaveBeenCalled();
  expect(api.newRunCodingEnvelope).not.toHaveBeenCalled();
});

it("restores a lost-response envelope and retries its original key only on explicit submission", async () => {
  persistPendingCommand({ ...admitted, commandId: null, payloadDigest: null });
  render(<ControlTower />);
  await waitFor(() => expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved"));
  expect(api.submitCommand).not.toHaveBeenCalled();
  expect(api.getCommand).not.toHaveBeenCalled();
  expect(loadPendingCommand()?.envelope).toEqual(envelope);
  fireEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
  await waitFor(() => expect(api.submitCommand).toHaveBeenCalledExactlyOnceWith(envelope));
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
  expect(api.newRunCodingEnvelope).not.toHaveBeenCalled();
});

it("retains the recorded subject and clears authentication after an unauthorized reload read", async () => {
  persistPendingCommand(admitted);
  vi.mocked(api.getCommand).mockRejectedValue(new api.ApiError("GET", `/api/v1/commands/${subject.id}`, 401, "expired"));
  render(<ControlTower />);
  await waitFor(() => expect(api.forgetBrowserSession).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Submit durable coding command" })).toBeDisabled();
  expect(loadPendingCommand()).toEqual(admitted);
  expect(api.submitCommand).not.toHaveBeenCalled();
});
