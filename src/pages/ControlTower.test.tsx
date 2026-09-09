import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { CommandStatus } from "../generated/api";
import { ControlTower } from "./ControlTower";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    exchangeBootstrap: vi.fn(),
    fetchHealth: vi.fn(),
    fetchOutbox: vi.fn(),
    forgetBrowserSession: vi.fn(),
    getCommand: vi.fn(),
    hasSessionMaterial: vi.fn(),
    listMissions: vi.fn(),
    newRunDemoEnvelope: vi.fn(),
    submitCommand: vi.fn(),
  };
});

const mocked = {
  exchangeBootstrap: vi.mocked(api.exchangeBootstrap),
  fetchHealth: vi.mocked(api.fetchHealth),
  fetchOutbox: vi.mocked(api.fetchOutbox),
  forgetBrowserSession: vi.mocked(api.forgetBrowserSession),
  getCommand: vi.mocked(api.getCommand),
  hasSessionMaterial: vi.mocked(api.hasSessionMaterial),
  listMissions: vi.mocked(api.listMissions),
  newRunDemoEnvelope: vi.mocked(api.newRunDemoEnvelope),
  submitCommand: vi.mocked(api.submitCommand),
};

const commandId = `cmd_${"a".repeat(64)}`;
const digest = "b".repeat(64);

function command(status: CommandStatus["status"], result: CommandStatus["result"] = null) {
  return { id: commandId, status, kind: "run_demo", payload_digest: digest, result };
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
  return new api.ApiError("GET", "/api/v1/missions", 500, "HTTP 500");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.hasSessionMaterial.mockReturnValue(true);
  mocked.listMissions.mockResolvedValue(snapshot([]));
  mocked.fetchOutbox.mockResolvedValue(snapshot({ items: [] }));
  mocked.fetchHealth.mockResolvedValue({ status: "ok" });
  mocked.newRunDemoEnvelope.mockReturnValue({
    idempotency_key: "portal_fixture",
    kind: "run_demo",
    payload: {},
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
  it("renders a failed missions read as unknown, never as an empty list", async () => {
    mocked.listMissions.mockRejectedValue(missionsError());
    render(<ControlTower />);
    const unknown = await screen.findByTestId("missions-unknown");
    expect(unknown).toHaveTextContent(
      "unknown: control plane unreachable (GET /api/v1/missions failed: HTTP 500)",
    );
    expect(screen.queryByText("No missions yet.")).not.toBeInTheDocument();
  });

  it("exchanges the one-time token before enabling command submission", async () => {
    mocked.hasSessionMaterial.mockReturnValue(false);
    render(<ControlTower />);
    const submit = screen.getByRole("button", { name: "Submit durable demo command" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("One-time bootstrap token"), "boot_fixture");
    await userEvent.click(screen.getByRole("button", { name: "Authenticate local session" }));
    await screen.findByText("local session material present; farmd revalidates every command");
    expect(mocked.exchangeBootstrap).toHaveBeenCalledWith("boot_fixture");
    expect(submit).toBeEnabled();
  });

  it("refuses a bare durable VERIFIED status without runtime Evidence and Effect receipts", async () => {
    mocked.getCommand
      .mockResolvedValueOnce(command("APPLIED", { applied: true }))
      .mockResolvedValueOnce(command("VERIFIED", { evidence: "PASS" }));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
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
    expect(card).toHaveTextContent("run_demo");
    expect(card).toHaveTextContent(digest);
    expect(card).toHaveTextContent("VERIFIED (receipt unavailable)");
    expect(card).toHaveTextContent("unverified generic result suppressed");
    expect(card).not.toHaveTextContent('{"evidence":"PASS"}');
    expect(card.querySelector(".verified")).toBeNull();
  });

  it("keeps a durable FAILED result red", async () => {
    mocked.getCommand.mockResolvedValue(command("FAILED", { error: "gate" }));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
    await waitFor(() => expect(screen.getByTestId("phase")).toHaveTextContent("FAILED"));
    expect(mocked.forgetBrowserSession).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("One-time bootstrap token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit durable demo command" })).toBeDisabled();
  });

  it("keeps a durable UNKNOWN result unknown", async () => {
    mocked.getCommand.mockResolvedValue(command("UNKNOWN"));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
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
    const button = screen.getByRole("button", { name: "Submit durable demo command" });
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
    const button = screen.getByRole("button", { name: "Submit durable demo command" });
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
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Submit durable demo command" }));
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

  it("renders a real health observation neutrally rather than as verification", async () => {
    render(<ControlTower />);
    await waitFor(() =>
      expect(screen.getByTestId("health-probe")).toHaveTextContent("farmd /health: ok"),
    );
    expect(screen.getByTestId("health-probe")).toHaveClass("idle");
    expect(screen.getByTestId("health-probe")).not.toHaveClass("verified");
  });
});
