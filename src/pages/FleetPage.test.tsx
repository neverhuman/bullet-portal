import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById, type Surface } from "../surfaces";
import { FleetPage } from "./FleetPage";

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

const lease = {
  variant_id: id("var", "1"),
  attempt_id: id("atm", "2"),
  fence: 3,
  runner_id: id("run", "3"),
  runner_epoch: 1,
  heartbeat_at: "2026-08-25T00:00:00.000Z",
  expires_at: "2026-08-25T00:00:15.000Z",
  ttl_seconds: 15,
  liveness: "expired",
  attempt_state: null,
  work_package_id: null,
  mission_id: null,
};

describe("FleetPage", () => {
  it("renders unknown when farmd is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    render(<FleetPage surface={surface("fleet")} />);
    await waitFor(() => {
      expect(screen.getByTestId("fleet-unknown")).toHaveTextContent(
        "unknown: Fleet: control plane unreachable (GET /api/v1/fleet failed: ECONNREFUSED)",
      );
    });
    expect(screen.queryByTestId("fleet-leases-empty")).toBeNull();
  });

  it("renders an empty ledger as zero rows verified at the watermark, never green", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ authority_time: "2026-08-25T00:00:01.000Z", leases: [], ready_queue: [] }, "5")),
    );
    render(<FleetPage surface={surface("fleet")} />);
    await waitFor(() => {
      expect(screen.getByTestId("fleet-leases-empty")).toHaveTextContent(
        "active leases: 0 rows (verified at sequence 5)",
      );
    });
    expect(screen.getByTestId("fleet-ready-empty")).toHaveTextContent(
      "ready queue: 0 rows (verified at sequence 5)",
    );
    expect(screen.getByTestId("fleet-authority-time")).toHaveTextContent("2026-08-25T00:00:01.000Z");
    expect(screen.getByTestId("fleet-summary")).toHaveTextContent("active leases 0 (live 0 · expired 0 · unknown 0) · ready-queue depth 0");
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent("as_of_sequence 5 · source bullet-kernel/sqlite-ledger");
    expect(screen.getByTestId("surface-fleet").querySelector(".verified")).toBeNull();
  });

  it("renders lease rows with store-clock liveness and linkage contradictions spelled out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          authority_time: "2026-08-25T00:00:20.000Z",
          leases: [lease],
          ready_queue: [{ work_package_id: id("wpk", "4"), enqueued_at: "2026-08-25T00:00:00.000Z" }],
        }),
      ),
    );
    render(<FleetPage surface={surface("fleet")} />);
    await waitFor(() => {
      expect(screen.getByTestId("fleet-leases-rows")).toHaveTextContent(id("atm", "2"));
    });
    const rows = screen.getByTestId("fleet-leases-rows");
    expect(rows).toHaveTextContent("expired");
    expect(rows).toHaveTextContent("contradictory: attempt row missing");
    expect(rows).toHaveTextContent("active leases: 1 rows (verified at sequence 3)");
    expect(screen.getByTestId("fleet-summary")).toHaveTextContent("live 0 · expired 1 · unknown 0");
    expect(screen.getByTestId("fleet-ready-rows")).toHaveTextContent(id("wpk", "4"));
  });

  it("refuses a body outside the generated schema and a header/body watermark mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ authority_time: "x", leases: [{ ...lease, liveness: "green" }], ready_queue: [] })),
    );
    render(<FleetPage surface={surface("fleet")} />);
    await waitFor(() => {
      expect(screen.getByTestId("fleet-unknown")).toHaveTextContent("schema validation");
    });
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ authority_time: "x", leases: [], ready_queue: [] }, "3", "4")),
    );
    render(<FleetPage surface={surface("fleet")} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("fleet-unknown").at(-1)).toHaveTextContent("watermark header/body mismatch");
    });
  });
});
