import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById } from "../surfaces";
import { ProjectedSurface } from "./ProjectedSurface";

const missionId = `mis_${"1".repeat(64)}`;
const organizationId = `org_${"2".repeat(64)}`;
const repositoryId = `rep_${"3".repeat(64)}`;
const acceptanceContractId = `acc_${"4".repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(data: unknown, sequence = "3"): Response {
  return new Response(JSON.stringify({
    data,
    as_of_sequence: Number(sequence),
    observed_at: "2026-08-24T22:00:00.000Z",
    source: "bullet-kernel/sqlite-ledger",
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-bullet-as-of-sequence": sequence,
    },
  });
}

describe("ProjectedSurface", () => {
  it("renders mission graph from farmd missions", async () => {
    const mission = {
      id: missionId,
      organization_id: organizationId,
      repository_id: repositoryId,
      title: "t",
      objective: "o",
      acceptance_contract_id: acceptanceContractId,
      state: "active",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/api/v1/missions")) {
          return json([mission]);
        }
        if (url.endsWith(`/api/v1/missions/${missionId}`)) {
          return json({ mission, packages: [], fence: 2 });
        }
        return new Response("missing", { status: 404 });
      }),
    );
    const surface = surfaceById("mission-graph");
    expect(surface).toBeDefined();
    if (surface === undefined) {
      return;
    }
    render(<ProjectedSurface surface={surface} />);
    await waitFor(() => {
      expect(screen.getByTestId("mission-graph-projection")).toHaveTextContent(missionId);
    });
    expect(screen.getByTestId("surface-mission-graph")).toHaveTextContent(
      "source bullet-kernel/sqlite-ledger",
    );
    expect(screen.getByTestId("surface-mission-graph")).toHaveTextContent(
      "observed_at 2026-08-24T22:00:00.000Z",
    );
  });

  it("renders unknown when farmd is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const surface = surfaceById("incidents-audit");
    expect(surface).toBeDefined();
    if (surface === undefined) {
      return;
    }
    render(<ProjectedSurface surface={surface} />);
    await waitFor(() => {
      expect(screen.getByTestId("incidents-audit-unknown")).toHaveTextContent("unknown:");
    });
  });

  it("refuses to combine projection snapshots from different sequences", async () => {
    const mission = {
      id: missionId,
      organization_id: organizationId,
      repository_id: repositoryId,
      title: "t",
      objective: "o",
      acceptance_contract_id: acceptanceContractId,
      state: "active",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        return url.endsWith("/api/v1/missions")
          ? json([mission], "3")
          : json({ mission, packages: [], fence: 2 }, "4");
      }),
    );
    const surface = surfaceById("mission-graph");
    expect(surface).toBeDefined();
    if (surface === undefined) {
      return;
    }
    render(<ProjectedSurface surface={surface} />);
    await waitFor(() => {
      expect(screen.getByTestId("mission-graph-unknown")).toHaveTextContent(
        "SNAPSHOT_WATERMARK_MISMATCH",
      );
    });
  });
});
