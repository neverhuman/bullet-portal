import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById, type Surface } from "../surfaces";
import { SessionSupervisorPage } from "./SessionSupervisorPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(data: unknown, sequence = "3", header = sequence): Response {
  return new Response(
    JSON.stringify({
      data,
      as_of_sequence: Number(sequence),
      observed_at: "2026-08-25T00:00:00.000Z",
      source: "bullet-kernel/sqlite-ledger",
    }),
    { status: 200, headers: { "content-type": "application/json", "x-bullet-as-of-sequence": header } },
  );
}

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

function surface(idValue: string): Surface {
  const found = surfaceById(idValue);
  if (found === undefined) {
    throw new Error(`${idValue} surface missing`);
  }
  return found;
}

const counts = [
  { label: "starting", count: 1 },
  { label: "crashed", count: 0 },
];

const attempt = {
  id: id("atm", "2"),
  variant_id: id("var", "1"),
  work_package_id: id("wpk", "4"),
  mission_id: id("mis", "5"),
  fence: 2,
  runner_id: id("run", "3"),
  runner_epoch: 1,
  workspace_id: id("wsp", "6"),
  scope_revision: 1,
  context_revision: 1,
  state: "starting",
  lease: "held",
  leased_at: "2026-08-25T00:00:00.000Z",
  last_lease_event: { seq: 2, at: "2026-08-25T00:00:00.000Z", kind: "attempt_leased" },
};

describe("SessionSupervisorPage", () => {
  it("renders unknown when farmd is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    render(<SessionSupervisorPage surface={surface("session-supervisor")} />);
    await waitFor(() => {
      expect(screen.getByTestId("session-supervisor-unknown")).toHaveTextContent(
        "unknown: Session Supervisor: control plane unreachable (GET /api/v1/sessions failed: ECONNREFUSED)",
      );
    });
  });

  it("renders zero attempts as verified-at-sequence while the state catalog stays explicit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ attempts: [], state_counts: counts.map((row) => ({ ...row, count: 0 })) }, "8")));
    render(<SessionSupervisorPage surface={surface("session-supervisor")} />);
    await waitFor(() => {
      expect(screen.getByTestId("sessions-attempts-empty")).toHaveTextContent(
        "attempt rows: 0 rows (verified at sequence 8)",
      );
    });
    expect(screen.getByTestId("sessions-states-rows")).toHaveTextContent("crashed");
    expect(screen.getByTestId("sessions-summary")).toHaveTextContent("attempts 0 · lease held 0");
    expect(screen.getByTestId("surface-session-supervisor").querySelector(".verified")).toBeNull();
  });

  it("renders attempt rows with lease possession and durable lease events", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ attempts: [attempt], state_counts: counts })));
    render(<SessionSupervisorPage surface={surface("session-supervisor")} />);
    await waitFor(() => {
      expect(screen.getByTestId("sessions-attempts-rows")).toHaveTextContent(id("atm", "2"));
    });
    const rows = screen.getByTestId("sessions-attempts-rows");
    expect(rows).toHaveTextContent("held");
    expect(rows).toHaveTextContent(id("wsp", "6"));
    expect(rows).toHaveTextContent("attempt_leased @ 2026-08-25T00:00:00.000Z (seq 2)");
    expect(screen.getByTestId("sessions-summary")).toHaveTextContent("attempts 1 · lease held 1");
  });

  it("spells out absent timestamps instead of inventing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ attempts: [{ ...attempt, lease: "none", leased_at: null, last_lease_event: null, mission_id: null }], state_counts: counts }),
      ),
    );
    render(<SessionSupervisorPage surface={surface("session-supervisor")} />);
    await waitFor(() => {
      expect(screen.getByTestId("sessions-attempts-rows")).toHaveTextContent("not recorded");
    });
    expect(screen.getByTestId("sessions-attempts-rows")).toHaveTextContent("none recorded");
    expect(screen.getByTestId("sessions-attempts-rows")).toHaveTextContent("unknown (no graph names it)");
  });
});
