import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById, type Surface } from "../surfaces";
import { QualityLabPage } from "./QualityLabPage";

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
  { label: "PASS", count: 0 },
  { label: "FLAKY", count: 1 },
  { label: "UNKNOWN", count: 0 },
];

describe("QualityLabPage", () => {
  it("renders unknown when farmd is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const unreachable = render(<QualityLabPage surface={surface("quality-lab")} />);
    await waitFor(() => {
      expect(screen.getByTestId("quality-lab-unknown")).toHaveTextContent(
        "unknown: Quality Lab: control plane unreachable (GET /api/v1/quality-lab failed: ECONNREFUSED)",
      );
    });
    unreachable.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          evidence: [
            {
              id: id("evd", "b"),
              candidate_id: id("can", "7"),
              tier: "E2",
              gate: "tests",
              result: "FLAKY",
              outcome: "FLAKY",
              satisfies_requirement: true,
            },
          ],
          outcome_counts: counts,
        }),
      ),
    );
    render(<QualityLabPage surface={surface("quality-lab")} />);
    await waitFor(() => {
      expect(screen.getByTestId("quality-lab-unknown")).toHaveTextContent(
        "snapshot body failed schema validation",
      );
    });
    expect(screen.queryByTestId("quality-lab-summary")).toBeNull();
  });

  it("renders zero evidence as verified-at-sequence with the outcome catalog explicit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ evidence: [], outcome_counts: counts.map((row) => ({ ...row, count: 0 })) }, "2")),
    );
    render(<QualityLabPage surface={surface("quality-lab")} />);
    await waitFor(() => {
      expect(screen.getByTestId("quality-lab-evidence-empty")).toHaveTextContent(
        "evidence rows: 0 rows (verified at sequence 2)",
      );
    });
    expect(screen.getByTestId("quality-lab-outcomes-rows")).toHaveTextContent("UNKNOWN");
    expect(screen.getByTestId("quality-lab-summary")).toHaveTextContent("evidence rows 0 · PASS 0");
    expect(screen.getByTestId("surface-quality-lab").querySelector(".verified")).toBeNull();
  });

  it("renders evidence with the typed outcome next to the stored label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          evidence: [
            {
              id: id("evd", "b"),
              candidate_id: id("can", "7"),
              tier: "E2",
              gate: "tests",
              result: "FLAKY",
              outcome: "FLAKY",
              satisfies_requirement: false,
            },
          ],
          outcome_counts: counts,
        }),
      ),
    );
    render(<QualityLabPage surface={surface("quality-lab")} />);
    await waitFor(() => {
      expect(screen.getByTestId("quality-lab-evidence-rows")).toHaveTextContent(id("evd", "b"));
    });
    expect(screen.getByTestId("quality-lab-evidence-rows")).toHaveTextContent("FLAKY");
    expect(screen.getByTestId("quality-lab-evidence-rows")).toHaveTextContent("false");
    expect(screen.getByTestId("quality-lab-summary")).toHaveTextContent("evidence rows 1 · PASS 0");
  });

});
