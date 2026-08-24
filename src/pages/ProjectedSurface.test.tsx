import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById } from "../surfaces";
import { ProjectedSurface } from "./ProjectedSurface";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(data: unknown, sequence = "3"): Response {
  return new Response(JSON.stringify(data), {
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
      id: "mis_demo",
      organization_id: "org_x",
      repository_id: "repo_x",
      title: "t",
      objective: "o",
      acceptance_contract_id: "acc_x",
      state: "active",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/v1/missions")) {
          return json([mission]);
        }
        if (url.endsWith("/v1/missions/mis_demo")) {
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
      expect(screen.getByTestId("mission-graph-projection")).toHaveTextContent("mis_demo");
    });
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
});
