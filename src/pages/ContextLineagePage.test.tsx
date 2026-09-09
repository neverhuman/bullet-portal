import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById, type Surface } from "../surfaces";
import { ContextLineagePage } from "./ContextLineagePage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

function surface(): Surface {
  const found = surfaceById("context-lineage");
  if (found === undefined) {
    throw new Error("context-lineage surface missing");
  }
  return found;
}

function json(data: unknown, sequence = "7"): Response {
  return new Response(
    JSON.stringify({
      data,
      as_of_sequence: Number(sequence),
      observed_at: "2026-08-25T00:00:00.000Z",
      source: "bullet-kernel/sqlite-ledger",
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-bullet-as-of-sequence": sequence,
      },
    },
  );
}

const capsule = {
  schema_version: "bullet.context-capsule.initial.v1",
  id: id("ctx", "1"),
  mission_id: id("mis", "2"),
  work_package_id: id("wpk", "3"),
  plan_revision_id: id("pln", "4"),
  revision: 1,
  parent_id: null,
  task_class: "security_analysis",
  objective_digest: "5".repeat(64),
  package_title_digest: "6".repeat(64),
  content_digest: "7".repeat(64),
  compression: "none",
  dropped_decision_digests: [],
  recorded_at: "2026-08-25T00:00:00.000Z",
};

describe("ContextLineagePage", () => {
  it("renders an empty durable lineage as zero rows, never green or UNKNOWN", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ capsules: [] }, "9")));
    render(<ContextLineagePage surface={surface()} />);
    await waitFor(() => {
      expect(screen.getByTestId("context-lineage-capsules-empty")).toHaveTextContent(
        "context capsules: 0 rows (verified at sequence 9)",
      );
    });
    expect(screen.getByTestId("context-lineage-summary")).toHaveTextContent(
      "raw objective and package title unavailable (digests only)",
    );
    expect(screen.getByTestId("context-lineage-summary")).toHaveTextContent(
      "no successor lineage claimed",
    );
    expect(screen.getByTestId("surface-context-lineage").querySelector(".verified")).toBeNull();
    expect(screen.queryByTestId("context-lineage-unknown")).toBeNull();
  });

  it("renders only exact initial capsule subjects and digests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ capsules: [capsule] })));
    render(<ContextLineagePage surface={surface()} />);
    await waitFor(() => {
      expect(screen.getByTestId("context-lineage-capsules-rows")).toHaveTextContent(capsule.id);
    });
    const rows = screen.getByTestId("context-lineage-capsules-rows");
    expect(rows).toHaveTextContent(capsule.work_package_id);
    expect(rows).toHaveTextContent(capsule.content_digest);
    expect(rows).toHaveTextContent("none (initial root)");
    expect(screen.getByRole("columnheader", { name: "compression" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "none" })).toBeInTheDocument();
    expect(rows).not.toHaveTextContent("bind exact initial context");
  });

  it("renders unknown for invented compression or successor fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          capsules: [
            {
              ...capsule,
              compression: "zstd",
              parent_id: id("ctx", "8"),
              dropped_decision_digests: ["9".repeat(64)],
              successor_verified: true,
            },
          ],
        }),
      ),
    );
    render(<ContextLineagePage surface={surface()} />);
    await waitFor(() => {
      expect(screen.getByTestId("context-lineage-unknown")).toHaveTextContent(
        "snapshot body failed schema validation",
      );
    });
    expect(screen.queryByTestId("context-lineage-capsules-rows")).toBeNull();
  });
});
