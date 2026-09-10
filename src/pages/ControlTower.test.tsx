import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { CommandStatus } from "../generated/api";
import {
  clearPendingCommand,
  loadPendingCommand,
  persistPendingCommand,
} from "../pendingCommand";
import { operatorSnapshotFixture } from "../testing/operatorSnapshot";
import { ControlTower } from "./ControlTower";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    exchangeBootstrap: vi.fn(),
    fetchFleet: vi.fn(),
    fetchOperatorSnapshot: vi.fn(),
    fetchHealth: vi.fn(),
    fetchOutbox: vi.fn(),
    fetchSessions: vi.fn(),
    forgetBrowserSession: vi.fn(),
    getCommand: vi.fn(),
    hasSessionMaterial: vi.fn(),
    listMissions: vi.fn(),
    newRunCodingEnvelope: vi.fn(),
    submitCommand: vi.fn(),
  };
});

const mocked = {
  exchangeBootstrap: vi.mocked(api.exchangeBootstrap),
  fetchFleet: vi.mocked(api.fetchFleet),
  fetchOperatorSnapshot: vi.mocked(api.fetchOperatorSnapshot),
  fetchHealth: vi.mocked(api.fetchHealth),
  fetchOutbox: vi.mocked(api.fetchOutbox),
  fetchSessions: vi.mocked(api.fetchSessions),
  forgetBrowserSession: vi.mocked(api.forgetBrowserSession),
  getCommand: vi.mocked(api.getCommand),
  hasSessionMaterial: vi.mocked(api.hasSessionMaterial),
  listMissions: vi.mocked(api.listMissions),
  newRunCodingEnvelope: vi.mocked(api.newRunCodingEnvelope),
  submitCommand: vi.mocked(api.submitCommand),
};

const commandId = `cmd_${"a".repeat(64)}`;
const digest = "b".repeat(64);
const slot = "bullet-farm.pending-command.v1";

const codingPayload = {
  account_id: "acct-local",
  provider: "claude",
  model: "claude-opus-4-6",
  expected_revision: 1,
  launch_nonce: "aa".repeat(32),
  quota_reservation: `rsv_${"bb".repeat(32)}`,
  quota_units: 1,
  allocated_run: `run_${"cc".repeat(32)}`,
};

function pendingRecord(key = "portal_fixture", id: string | null = commandId) {
  return {
    envelope: { idempotency_key: key, kind: "run_coding", payload: codingPayload },
    commandId: id, kind: "run_coding", payloadDigest: id === null ? null : digest,
  };
}


function command(status: CommandStatus["status"], result: CommandStatus["result"] = null) {
  return { id: commandId, status, kind: "run_coding", payload_digest: digest, result };
}

function snapshot<T>(data: T, asOfSequence = 0): api.SnapshotRead<T> {
  return {
    data,
    asOfSequence,
    observedAt: "2026-08-24T22:00:00.000Z",
    source: "bullet-kernel/sqlite-ledger",
  };
}

function missionsError(): api.ApiError {
  return new api.ApiError("GET", "/api/v1/operator-snapshot", 500, "HTTP 500");
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingCommand();
  mocked.hasSessionMaterial.mockReturnValue(true);
  mocked.listMissions.mockResolvedValue(snapshot([]));
  mocked.fetchOperatorSnapshot.mockResolvedValue(snapshot(operatorSnapshotFixture()));
  mocked.fetchOutbox.mockResolvedValue(snapshot({ items: [] }));
  mocked.fetchFleet.mockResolvedValue(
    snapshot({ authority_time: "2026-09-09T00:00:00.000Z", leases: [], ready_queue: [] }),
  );
  mocked.fetchSessions.mockResolvedValue(snapshot({ attempts: [], state_counts: [] }));
  mocked.fetchHealth.mockResolvedValue({ status: "ok" });
  mocked.newRunCodingEnvelope.mockReturnValue({
    idempotency_key: "portal_fixture",
    kind: "run_coding",
    payload: codingPayload,
  });
  mocked.submitCommand.mockResolvedValue(command("PENDING"));
  mocked.getCommand.mockResolvedValue(command("UNKNOWN"));
  mocked.exchangeBootstrap.mockResolvedValue({
    status: "AUTHENTICATED",
    csrf_token: `csrf_${"c".repeat(64)}`,
    expires_in_seconds: 900,
  });
});

describe("ControlTower command honesty", () => {
  it("publishes only the aggregate snapshot and preserves operator input during refresh", async () => {
    mocked.fetchOperatorSnapshot.mockResolvedValue(snapshot(operatorSnapshotFixture(7), 7));
    render(<ControlTower />);
    await screen.findByText("No missions yet.");
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: 7");
    for (const read of [mocked.listMissions, mocked.fetchOutbox, mocked.fetchFleet, mocked.fetchSessions]) {
      expect(read).not.toHaveBeenCalled();
    }
    await userEvent.clear(screen.getByLabelText("Account"));
    await userEvent.type(screen.getByLabelText("Account"), "acct-selected");
    mocked.fetchOperatorSnapshot.mockResolvedValue(snapshot(operatorSnapshotFixture(8), 8));
    await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: 8"));
    expect(screen.getByLabelText("Account")).toHaveValue("acct-selected");
    expect(mocked.submitCommand).not.toHaveBeenCalled();
  });

  it("renders a failed missions read as unknown, never as an empty list", async () => {
    mocked.fetchOperatorSnapshot.mockRejectedValue(missionsError());
    render(<ControlTower />);
    const unknown = await screen.findByTestId("missions-unknown");
    expect(unknown).toHaveTextContent(
      "unknown: Operator snapshot: control plane unreachable (GET /api/v1/operator-snapshot failed: HTTP 500)",
    );
    expect(screen.queryByText("No missions yet.")).not.toBeInTheDocument();
    expect(screen.getByTestId("outbox-unknown")).toHaveTextContent("operator-snapshot");
    expect(screen.getByTestId("as-of-sequence")).toHaveTextContent("as_of_sequence: unknown");
  });

  it("exchanges the one-time token before enabling command submission", async () => {
    mocked.hasSessionMaterial.mockReturnValue(false);
    render(<ControlTower />);
    const submit = screen.getByRole("button", { name: "Submit durable coding command" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("One-time bootstrap token"), "boot_fixture");
    await userEvent.click(screen.getByRole("button", { name: "Authenticate local session" }));
    await screen.findByText("local session material present; farmd revalidates every command");
    expect(mocked.exchangeBootstrap).toHaveBeenCalledWith("boot_fixture");
    expect(submit).toBeEnabled();
    expect(screen.getByTestId("hold-banner")).toHaveTextContent("STOP_UNIMPLEMENTED");
  });

  it("refuses a bare durable VERIFIED status without runtime Evidence and Effect receipts", async () => {
    mocked.getCommand
      .mockResolvedValueOnce(command("APPLIED", { applied: true }))
      .mockResolvedValueOnce(command("VERIFIED", { evidence: "PASS" }));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("APPLIED"));
    expect(screen.getByTestId("phase")).toHaveClass("pending");
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("phase")).toHaveClass("unknown");
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      `command ${commandId} reported durable VERIFIED`,
    );
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      "no generated runtime Evidence and Effect receipt contract is available",
    );
    const card = screen.getByTestId("command");
    expect(card).toHaveTextContent(commandId);
    expect(card).toHaveTextContent("run_coding");
    expect(card).toHaveTextContent(digest);
    expect(card).toHaveTextContent("VERIFIED (receipt unavailable)");
    expect(card).toHaveTextContent("unverified generic result suppressed");
    expect(card).not.toHaveTextContent('{"evidence":"PASS"}');
    expect(card.querySelector(".verified")).toBeNull();
  });

  it("keeps a durable FAILED result red", async () => {
    mocked.getCommand.mockResolvedValue(command("FAILED", { error: "gate" }));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("FAILED"));
    expect(screen.getByTestId("phase")).toHaveClass("failed");
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      `command ${commandId} durably FAILED`,
    );
  });

  it("clears stale local session material after a definitive authorization refusal", async () => {
    mocked.submitCommand.mockRejectedValue(
      new api.ApiError("POST", "/api/v1/commands", 401, "SESSION_INVALID"),
    );
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("FAILED"));
    expect(mocked.forgetBrowserSession).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("One-time bootstrap token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit durable coding command" })).toBeDisabled();
  });

  it("keeps a durable UNKNOWN result unknown", async () => {
    mocked.getCommand.mockResolvedValue(command("UNKNOWN"));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("phase")).toHaveClass("unknown");
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      `command ${commandId} durably UNKNOWN`,
    );
  });

  it("turns a reconciliation timeout into local UNKNOWN, never FAILED", async () => {
    mocked.getCommand.mockRejectedValue(
      new api.ApiError("GET", `/api/v1/commands/${commandId}`, null, "timeout after 10000ms"),
    );
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("phase")).toHaveClass("unknown");
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      `command ${commandId} reconciliation unknown`,
    );
    expect(screen.getByTestId("mutation-error")).not.toHaveTextContent("durably FAILED");
  });

  it("clears an older terminal command before a later admission fails", async () => {
    mocked.submitCommand
      .mockResolvedValueOnce(command("PENDING"))
      .mockRejectedValueOnce(new api.ApiError("POST", "/api/v1/commands", 500, "HTTP 500"));
    render(<ControlTower />);
    const button = screen.getByRole("button", { name: "Submit durable coding command" });
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("command")).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("FAILED"));
    expect(screen.queryByTestId("command")).not.toBeInTheDocument();
  });

  it("renders an ambiguous admission as UNKNOWN without adopting an older result", async () => {
    mocked.submitCommand
      .mockResolvedValueOnce(command("PENDING"))
      .mockRejectedValueOnce(
        new api.ApiError("POST", "/api/v1/commands", null, "timeout after 10000ms"),
      );
    render(<ControlTower />);
    const button = screen.getByRole("button", { name: "Submit durable coding command" });
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      "command admission outcome unknown; no command id was received",
    );
    expect(screen.queryByTestId("command")).not.toBeInTheDocument();
  });

  it("fails closed when reconciliation changes the admitted subject", async () => {
    mocked.getCommand.mockResolvedValue({
      ...command("VERIFIED", { evidence: "PASS" }),
      payload_digest: "c".repeat(64),
    });
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      "reconciliation returned conflicting durable truth",
    );
    expect(screen.getByTestId("command")).not.toHaveClass("verified");
  });

  it("fails closed when the same command regresses from APPLIED to PENDING", async () => {
    mocked.getCommand
      .mockResolvedValueOnce(command("APPLIED", { applied: true }))
      .mockResolvedValueOnce(command("PENDING"));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      "reconciliation returned conflicting durable truth",
    );
  });

  it("renders the health probe as unknown when /health fails", async () => {
    mocked.fetchHealth.mockRejectedValue(
      new api.ApiError("GET", "/health", null, "timeout after 10000ms"),
    );
    render(<ControlTower />);
    await waitFor(() =>
      expect(screen.getByTestId("health-probe")).toHaveTextContent(
        "unknown: GET /health failed: timeout after 10000ms",
      ),
    );
    expect(screen.getByTestId("health-probe")).toHaveClass("unknown");
  });

  it("persists the envelope before POST and retries the same key after lost admission", async () => {
    mocked.submitCommand.mockRejectedValue(
      new api.ApiError("POST", "/api/v1/commands", null, "timeout after 10000ms"),
    );
    render(<ControlTower />);
    const button = screen.getByRole("button", { name: "Submit durable coding command" });
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    await userEvent.click(button);
    await waitFor(() => expect(mocked.submitCommand).toHaveBeenCalledTimes(2));
    expect(mocked.submitCommand).toHaveBeenNthCalledWith(1, {
      idempotency_key: "portal_fixture",
      kind: "run_coding",
      payload: codingPayload,
    });
    expect(mocked.submitCommand).toHaveBeenNthCalledWith(2, {
      idempotency_key: "portal_fixture",
      kind: "run_coding",
      payload: codingPayload,
    });
    expect(mocked.newRunCodingEnvelope).toHaveBeenCalledTimes(1);
  });

  it("resumes an admitted command after reload instead of minting a new key", async () => {
    persistPendingCommand(pendingRecord("portal_fixture"));
    render(<ControlTower />);
    await waitFor(() => expect(mocked.getCommand).toHaveBeenCalledWith(commandId));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(mocked.submitCommand).not.toHaveBeenCalled();
    expect(mocked.newRunCodingEnvelope).not.toHaveBeenCalled();
  });

  it("keeps the envelope and stays UNKNOWN when admitted-id persistence fails", async () => {
    persistPendingCommand(pendingRecord("portal_fixture", null));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      render(<ControlTower />);
      await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
      await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    } finally {
      setItem.mockRestore();
    }
    expect(loadPendingCommand()?.envelope.idempotency_key).toBe("portal_fixture");
    expect(loadPendingCommand()?.commandId).toBeNull();
  });

  it("retains a newer pending slot when an unmounted GET later completes", async () => {
    let resolveOld = (_value: ReturnType<typeof command>): void => { throw new Error("old GET not started"); };
    mocked.getCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    persistPendingCommand(pendingRecord("portal_old"));
    const first = render(<ControlTower />);
    await waitFor(() => expect(mocked.getCommand).toHaveBeenCalledWith(commandId));
    first.unmount();
    const laterId = `cmd_${"e".repeat(64)}`;
    persistPendingCommand({
      envelope: { idempotency_key: "portal_later", kind: "run_coding", payload: codingPayload },
      commandId: laterId,
      kind: "run_coding",
      payloadDigest: "f".repeat(64),
    });
    mocked.getCommand.mockResolvedValueOnce({
      id: laterId,
      status: "PENDING",
      kind: "run_coding",
      payload_digest: "f".repeat(64),
      result: null,
    });
    render(<ControlTower />);
    await act(async () => { resolveOld(command("UNKNOWN")); });
    await waitFor(() => expect(loadPendingCommand()?.commandId).toBe(laterId));
    expect(loadPendingCommand()?.envelope.idempotency_key).toBe("portal_later");
  });

  it("retains custody when a restored GET changes kind or digest", async () => {
    persistPendingCommand(pendingRecord("portal_fixture"));
    mocked.getCommand.mockResolvedValue({
      ...command("UNKNOWN"),
      kind: "run_demo",
    });
    render(<ControlTower />);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    expect(screen.getByTestId("mutation-error")).toHaveTextContent("restored subject conflicts");
    expect(loadPendingCommand()?.commandId).toBe(commandId);
    expect(mocked.submitCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "{"],
    ["legacy admitted", JSON.stringify({ envelope: pendingRecord().envelope, commandId })],
  ])("keeps %s custody UNKNOWN without a new POST", async (_label, raw) => {
    sessionStorage.setItem(slot, raw);
    render(<ControlTower />);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    expect(mocked.submitCommand).not.toHaveBeenCalled();
    expect(mocked.newRunCodingEnvelope).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(slot)).toBe(raw);
  });

  it("displays unreadable storage as UNKNOWN without a new POST", async () => {
    persistPendingCommand(pendingRecord("portal_fixture", null));
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      render(<ControlTower />);
      await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
      await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
      expect(mocked.submitCommand).not.toHaveBeenCalled();
      expect(mocked.newRunCodingEnvelope).not.toHaveBeenCalled();
    } finally { getItem.mockRestore(); }
    expect(loadPendingCommand()).toEqual(pendingRecord("portal_fixture", null));
  });

  it.each([
    ["kind", { kind: "run_demo", payload: {} }],
    ["payload", { kind: "run_coding", payload: { ...codingPayload, account_id: "acct-other" } }],
  ] as const)("refuses a pending %s that conflicts with the coding action", async (_label, scope) => {
    const stored = pendingRecord("portal_other", null);
    persistPendingCommand({ ...stored, kind: scope.kind, envelope: { ...stored.envelope, ...scope } });
    render(<ControlTower />);
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN"));
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    expect(mocked.submitCommand).not.toHaveBeenCalled();
    expect(mocked.newRunCodingEnvelope).not.toHaveBeenCalled();
    expect(loadPendingCommand()?.envelope).toEqual({ ...stored.envelope, ...scope });
  });

  it("ignores a late unmounted POST after the current tower retries and starts another command", async () => {
    let resolveOld = (_value: ReturnType<typeof command>): void => { throw new Error("old POST not started"); };
    mocked.submitCommand.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const first = render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    expect(mocked.submitCommand).toHaveBeenCalledTimes(1);
    first.unmount();
    const current = render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(loadPendingCommand()).toBeNull());
    const laterId = `cmd_${"e".repeat(64)}`;
    const later = pendingRecord("portal_later", laterId);
    mocked.newRunCodingEnvelope.mockReturnValue(later.envelope);
    mocked.submitCommand.mockResolvedValue({ ...command("PENDING"), id: laterId });
    mocked.getCommand.mockResolvedValue({ ...command("PENDING"), id: laterId });
    await userEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));
    await waitFor(() => expect(loadPendingCommand()).toEqual(later));
    await act(async () => { resolveOld(command("PENDING")); });
    expect(loadPendingCommand()).toEqual(later);
    expect(mocked.submitCommand).toHaveBeenCalledTimes(3);
    expect(mocked.submitCommand.mock.calls[0][0]).toEqual(mocked.submitCommand.mock.calls[1][0]);
    expect(mocked.newRunCodingEnvelope).toHaveBeenCalledTimes(2);
    current.unmount();
  });

  it("polls while mounted and stops the old generation on unmount", async () => {
    persistPendingCommand(pendingRecord());
    mocked.getCommand.mockResolvedValue(command("PENDING"));
    const view = render(<ControlTower />);
    await waitFor(() => expect(mocked.getCommand.mock.calls.length).toBeGreaterThanOrEqual(2));
    view.unmount();
    const count = mocked.getCommand.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(mocked.getCommand).toHaveBeenCalledTimes(count);
    expect(loadPendingCommand()).toEqual(pendingRecord());
  });

  it("renders a real health observation neutrally rather than as verification", async () => {
    render(<ControlTower />);
    await waitFor(() =>
      expect(screen.getByTestId("health-probe")).toHaveTextContent("farmd /health: ok"),
    );
    expect(screen.getByTestId("health-probe")).toHaveClass("idle");
    expect(screen.getByTestId("health-probe")).not.toHaveClass("verified");
  });

  it("projects an empty fleet as labeled zero rows, never a green multi-agent process", async () => {
    render(<ControlTower />);
    await waitFor(() =>
      expect(screen.getByTestId("insight-fleet")).toHaveTextContent(
        "fleet LIVE 0 · EXPIRED 0 · UNKNOWN 0 · ready 0",
      ),
    );
    expect(screen.getByTestId("hold-banner")).toHaveTextContent("HOLD");
    expect(screen.getByTestId("hold-banner")).toHaveTextContent("STOP_UNIMPLEMENTED");
    expect(screen.getByTestId("insight-sessions")).toHaveTextContent("sessions attempts 0 · HELD 0");
    expect(screen.getByTestId("insight-honesty")).toHaveTextContent("Empty is zero rows");
    expect(screen.getByTestId("insight-fleet")).toHaveClass("chip-idle");
    expect(screen.getByTestId("insight-fleet")).not.toHaveClass("chip-live");
  });
});
