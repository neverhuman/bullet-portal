import { getOperatorSession } from "../apiAuth";
import { discoverOwner } from "../apiOwner";
import { hasSessionMaterial as realMaterial, csrfToken } from "../apiSession";
import { setupOwner, identity } from "../testing/pendingOwner";
vi.mock("../apiAuth", () => ({ getOperatorSession: vi.fn(), revokeOperatorSession: vi.fn() }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { prepareCommand } from "../commandIdentity";
import { clearPendingCommand, loadPendingCommand, persistPendingCommand } from "../testing/pendingOwner";
import { codingPayload } from "../testing/commands";
import { operatorSnapshotFixture } from "../testing/operatorSnapshot";
import { ControlTower } from "./ControlTower";
import { forgetBrowserSession, rememberCsrfToken } from "../apiSession";

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
  vi.clearAllMocks(); setupOwner(); clearPendingCommand();
  vi.mocked(api.hasSessionMaterial).mockImplementation(realMaterial);
  vi.mocked(api.fetchHealth).mockResolvedValue({ status: "ok" });
  vi.mocked(api.fetchOperatorSnapshot).mockResolvedValue({ data: operatorSnapshotFixture(),
    asOfSequence: 0, observedAt: "2026-09-10T03:00:00Z", source: "bullet-kernel/sqlite-ledger" });
  vi.mocked(api.getCommand).mockResolvedValue(terminal);
  vi.mocked(api.submitCommand).mockResolvedValue(terminal);
});
afterEach(() => { cleanup(); clearPendingCommand(); forgetBrowserSession(); });

it("reconciles a recorded admission after reload regardless of new form defaults", async () => {
  persistPendingCommand(admitted);
  render(<ControlTower />);
  await waitFor(() => expect(api.getCommand).toHaveBeenCalledExactlyOnceWith(subject.id, expect.any(AbortSignal), { "x-bullet-expected-session": identity.session_id }));
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
  vi.mocked(api.getCommand).mockRejectedValueOnce(Object.assign(new api.ApiError("GET", "/commands", 404, "absent", false, undefined, identity.session_id), { code: "NOT_FOUND" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
  await waitFor(() => expect(api.submitCommand).toHaveBeenCalledExactlyOnceWith(envelope, { signal: expect.any(AbortSignal), csrf: "fixture-csrf" }));
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
  expect(api.newRunCodingEnvelope).not.toHaveBeenCalled();
});

it("retains the recorded subject and clears authentication after an unauthorized reload read", async () => {
  persistPendingCommand(admitted);
  vi.mocked(api.getCommand).mockRejectedValue(new api.ApiError("GET", `/api/v1/commands/${subject.id}`, 401, "expired"));
  render(<ControlTower />);
  await waitFor(() => expect(csrfToken()).toBeNull());
  expect(screen.getByRole("button", { name: "Submit durable coding command" })).toBeDisabled();
  expect(loadPendingCommand()).toEqual(admitted);
  expect(api.submitCommand).not.toHaveBeenCalled();
});

it("clears prior-owner fields and ignores an old command read after authentication changes", async () => {
  persistPendingCommand(admitted);
  let finish!: (value: typeof terminal) => void;
  vi.mocked(api.getCommand).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<ControlTower />);
  await waitFor(() => expect(api.getCommand).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved");
  vi.mocked(getOperatorSession).mockResolvedValue({ status: "AUTHENTICATED", operator_id: `opr_${"3".repeat(64)}`, session_id: `sid_${"4".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" });
  await act(async () => { rememberCsrfToken("new-owner"); });
  expect(screen.getByLabelText("Account")).toHaveValue("acct-local");
  expect(screen.getByTestId("phase")).toHaveTextContent("IDLE");
  await act(async () => { finish(terminal); });
  expect(screen.queryByText(subject.id)).not.toBeInTheDocument();
  expect(screen.queryByTestId("mutation-error")).not.toBeInTheDocument();
  expect(loadPendingCommand()).toEqual(admitted);
  expect(api.submitCommand).not.toHaveBeenCalled();
});


it("restores the same operator's exact saved request after reauthentication without remounting", async () => {
  persistPendingCommand({ ...admitted, commandId: null, payloadDigest: null });
  render(<ControlTower />);
  await waitFor(() => expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved"));
  await act(async () => { forgetBrowserSession(); });
  expect(screen.getByLabelText("Account")).toHaveValue("acct-local");
  await act(async () => { rememberCsrfToken("renewed-csrf"); });
  await waitFor(() => expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved"));
  fireEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
  expect(api.getCommand).toHaveBeenCalledExactlyOnceWith(subject.id, expect.any(AbortSignal), { "x-bullet-expected-session": identity.session_id });
  expect(api.submitCommand).not.toHaveBeenCalled();
  expect(api.newRunCodingEnvelope).not.toHaveBeenCalled();
});

it("retains a newer authenticated selection when an earlier command read refuses", async () => {
  persistPendingCommand(admitted);
  let reject!: (error: unknown) => void;
  vi.mocked(api.getCommand).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<ControlTower />);
  await waitFor(() => expect(api.getCommand).toHaveBeenCalledOnce());
  await discoverOwner();
  await act(async () => { reject(new api.ApiError("GET", "/commands", 401, "old failure")); });
  expect(csrfToken()).toBe("fixture-csrf");
  expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved");
  expect(screen.getByRole("button", { name: "Submit durable coding command" })).toBeEnabled();
  expect(loadPendingCommand()).toEqual(admitted);
});

it("does not expose another operator's prepared request when mounting under a different owner", async () => {
  persistPendingCommand({ ...admitted, commandId: null, payloadDigest: null });
  vi.mocked(getOperatorSession).mockResolvedValue({ status: "AUTHENTICATED", operator_id: `opr_${"3".repeat(64)}`, session_id: `sid_${"4".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" });
  rememberCsrfToken("operator-b");
  render(<ControlTower />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Submit durable coding command" })).toBeEnabled());
  expect(screen.getByLabelText("Account")).toHaveValue("acct-local");
  expect(screen.getByLabelText("Model")).not.toHaveValue("saved-model");
  expect(api.getCommand).not.toHaveBeenCalled(); expect(api.submitCommand).not.toHaveBeenCalled();
  await act(async () => { setupOwner(); });
  await waitFor(() => expect(screen.getByLabelText("Account")).toHaveValue("acct-cursor-saved"));
  expect(loadPendingCommand()?.envelope).toEqual(envelope);
});
