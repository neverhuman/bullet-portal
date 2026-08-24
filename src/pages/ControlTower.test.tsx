import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { DemoReceipt } from "../generated/api";
import { ControlTower } from "./ControlTower";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    listMissions: vi.fn(),
    runDemo: vi.fn(),
    fetchOutbox: vi.fn(),
    fetchHealth: vi.fn(),
  };
});

const mocked = {
  listMissions: vi.mocked(api.listMissions),
  runDemo: vi.mocked(api.runDemo),
  fetchOutbox: vi.mocked(api.fetchOutbox),
  fetchHealth: vi.mocked(api.fetchHealth),
};

const receipt: DemoReceipt = {
  mission_id: "mis_demo",
  plan_hash: "abc",
  fence: 1,
  attempt_id: "atm_live",
  fence_second: 2,
  attempt_second_id: "atm_second",
  stale_attempt_id: "atm_stale",
  candidate_head: "b".repeat(40),
  evidence_result: "PASS",
  effect_outcome: "verified",
  effect_unknown_outcome: "unknown",
  materialize_idempotent: true,
  stale_refused: true,
};

function missionsError(): api.ApiError {
  return new api.ApiError("GET", "/v1/missions", 500, "HTTP 500");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listMissions.mockResolvedValue([]);
  mocked.fetchOutbox.mockResolvedValue({ items: [] });
  mocked.fetchHealth.mockResolvedValue({ status: "ok" });
  mocked.runDemo.mockResolvedValue(receipt);
});

describe("ControlTower honesty", () => {
  it("renders a failed missions read as unknown, never as an empty list", async () => {
    mocked.listMissions.mockRejectedValue(missionsError());
    render(<ControlTower />);
    const unknown = await screen.findByTestId("missions-unknown");
    expect(unknown).toHaveTextContent(
      "unknown: control plane unreachable (GET /v1/missions failed: HTTP 500)",
    );
    expect(screen.queryByText("No missions yet.")).not.toBeInTheDocument();
  });

  it("marks a failed run as failed and keeps the error visible", async () => {
    mocked.runDemo.mockRejectedValue(new api.ApiError("POST", "/v1/demo/run", 500, "HTTP 500"));
    render(<ControlTower />);
    await userEvent.click(screen.getByRole("button", { name: "Run simulator demo" }));
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("mutation phase: failed"),
    );
    expect(screen.getByTestId("phase")).toHaveClass("failed");
    expect(screen.getByTestId("mutation-error")).toHaveTextContent(
      "POST /v1/demo/run failed: HTTP 500",
    );
  });

  it("keeps the verified phase when the follow-up refresh fails", async () => {
    mocked.listMissions.mockResolvedValueOnce([]).mockRejectedValueOnce(missionsError());
    render(<ControlTower />);
    await screen.findByTestId("missions-empty");
    await userEvent.click(screen.getByRole("button", { name: "Run simulator demo" }));
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("mutation phase: verified"),
    );
    await screen.findByTestId("missions-unknown");
    expect(screen.getByTestId("phase")).toHaveTextContent("mutation phase: verified");
    expect(screen.getByTestId("phase")).toHaveClass("verified");
    expect(screen.getByTestId("receipt")).toHaveTextContent("atm_live");
  });

  it("blocks double submit while a run is pending", async () => {
    let release: (value: DemoReceipt) => void = () => {};
    mocked.runDemo.mockImplementation(
      () =>
        new Promise<DemoReceipt>((resolve) => {
          release = resolve;
        }),
    );
    render(<ControlTower />);
    const button = screen.getByRole("button", { name: "Run simulator demo" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("mutation phase: pending"),
    );
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(mocked.runDemo).toHaveBeenCalledTimes(1);
    release(receipt);
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("mutation phase: verified"),
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

  it("renders the health probe green only on a real ok", async () => {
    render(<ControlTower />);
    await waitFor(() =>
      expect(screen.getByTestId("health-probe")).toHaveTextContent("farmd /health: ok"),
    );
    expect(screen.getByTestId("health-probe")).toHaveClass("verified");
  });
});
