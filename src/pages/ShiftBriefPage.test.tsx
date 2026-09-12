import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorSnapshotFixture } from "../testing/operatorSnapshot";
import { NO_LEDGER_SUBJECT, SURFACES, surfaceById, type Surface } from "../surfaces";
import { briefRow, ShiftBriefPage, type Provenance } from "./ShiftBriefPage";


vi.mock("../apiAuth", () => ({ getOperatorSession: vi.fn(async () => ({
  status: "AUTHENTICATED", operator_id: `opr_${"1".repeat(64)}`, session_id: `sid_${"2".repeat(64)}`,
  issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z",
})) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ABSENT_SUBJECT_SURFACES = [
  "cognitive-router",
  "fusion-lab",
  "quota-capacity",
  "struggle-cockpit",
  "behavior-center",
  "workspace-hygiene",
];

function json(data: unknown, sequence: number): Response {
  return new Response(
    JSON.stringify({
      data,
      as_of_sequence: sequence,
      observed_at: "2026-08-25T00:00:00.000Z",
      source: "bullet-kernel/sqlite-ledger",
    }),
    {
      status: 200,
      headers: { "x-bullet-session-id": `sid_${"2".repeat(64)}`, "content-type": "application/json", "x-bullet-as-of-sequence": String(sequence) },
    },
  );
}

function stubUnreachable(): void {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
}

function statusText(id: string): string {
  return screen.getByTestId(`brief-${id}-status`).textContent ?? "";
}

function surface(id: string): Surface {
  const found = surfaceById(id);
  if (found === undefined) {
    throw new Error(`${id} surface missing`);
  }
  return found;
}

/** Every durable read has returned: no row is still NONE_LOADING. */
async function settled(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryAllByText("NONE_LOADING")).toHaveLength(0);
  });
}

describe("ShiftBriefPage", () => {
  it("lists every surface exactly once with its status", async () => {
    stubUnreachable();
    render(<ShiftBriefPage />);
    expect(screen.getByRole("heading", { name: "Shift Brief" })).toBeInTheDocument();
    const table = screen.getByTestId("shift-brief-rows");
    const region = screen.getByRole("region", { name: "Shift Brief" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toContainElement(table);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(15);
    for (const item of SURFACES) {
      expect(screen.getAllByTestId(`brief-row-${item.id}`)).toHaveLength(1);
      expect(statusText(item.id)).toBe(ABSENT_SUBJECT_SURFACES.includes(item.id) ? "unknown" : "durable");
    }
    await settled();
    expect(screen.getByTestId("shift-brief-summary")).toHaveTextContent(
      "15 surfaces · durable 9 (read at a sequence 0, read unknown 9) · unknown 6 · profile availability unknown",
    );
    expect(screen.getByTestId("shift-brief-decision")).toHaveTextContent(
      "RELEASE DECISION: unknown — no release-truth subject is projected to the Portal",
    );
    expect(screen.getByTestId("shift-brief-decision")).toHaveClass("unknown");
    expect(screen.getByTestId("shift-brief-tagline")).toHaveTextContent(
      "profile availability unknown (farmd serves no selected-profile subject",
    );
  });

  it("renders the six absent-subject surfaces only as non-empty unknown, never another status", async () => {
    stubUnreachable();
    render(<ShiftBriefPage />);
    await settled();
    expect(screen.getByTestId("shift-brief").querySelector(".verified, .live, .pending")).toBeNull();
    expect(document.body.textContent).not.toContain("OUT_OF_PROFILE");
    for (const id of ABSENT_SUBJECT_SURFACES) {
      const status = screen.getByTestId(`brief-${id}-status`);
      expect(status, id).toHaveClass("unknown");
      expect(status.textContent, id).toBe("unknown");
      expect(screen.getByTestId(`brief-${id}-evidence`), id).toHaveTextContent("NONE_NO_SUBJECT");
      expect(screen.getByTestId(`brief-${id}-subject`), id).toHaveTextContent("none (no ledger subject)");
      expect(screen.getByTestId(`brief-${id}-blocker`), id).toHaveTextContent(`unknown: ${NO_LEDGER_SUBJECT}`);
      expect(screen.getByTestId(`brief-${id}-blocker`), id).toHaveTextContent(/V1-S[46]/);
      expect(screen.getByTestId(`brief-${id}-freshness`), id).toHaveTextContent("unknown");
      expect(screen.getByTestId(`brief-${id}-claim`), id).toHaveTextContent("(unproved: no ledger subject)");
      expect(screen.getByTestId(`brief-${id}-next`), id).toHaveTextContent("the Portal cannot mint it");
      for (const cell of screen.getByTestId(`brief-row-${id}`).querySelectorAll("td")) {
        expect(cell.textContent?.trim(), id).not.toBe("");
      }
    }
  });

  it("renders an unreachable durable surface as unknown evidence, never empty and never green", async () => {
    stubUnreachable();
    render(<ShiftBriefPage />);
    await settled();
    expect(screen.getByTestId("brief-fleet-evidence")).toHaveTextContent("NONE_UNREACHABLE");
    expect(screen.getByTestId("brief-fleet-status")).toHaveClass("unknown");
    expect(screen.getByTestId("brief-fleet-blocker")).toHaveTextContent(
      "unknown: Operator snapshot: control plane unreachable (GET /api/v1/operator-snapshot failed: ECONNREFUSED)",
    );
    expect(screen.getByTestId("brief-fleet-freshness")).toHaveTextContent("unknown");
    expect(screen.getByTestId("brief-fleet-subject")).toHaveTextContent("unknown (read failed)");
    expect(screen.getByTestId("brief-fleet-claim")).toHaveTextContent("(unproved: read failed)");
    for (const cell of screen.getByTestId("brief-row-fleet").querySelectorAll("td")) {
      expect(cell.textContent?.trim()).not.toBe("");
    }
    expect(screen.getByTestId("shift-brief").querySelector(".verified")).toBeNull();
  });

  it("carries one shared provenance for every durable surface and refreshes it together", async () => {
    const urls: string[] = [];
    let sequence = 7;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      urls.push(input);
      if (input.endsWith("/api/v1/operator-snapshot")) return json(operatorSnapshotFixture(sequence), sequence);
      return new Response("no stream", { status: 404 });
    }));
    render(<ShiftBriefPage />);
    await settled();
    for (const item of SURFACES.filter((item) => !ABSENT_SUBJECT_SURFACES.includes(item.id))) {
      expect(screen.getByTestId(`brief-${item.id}-evidence`)).toHaveTextContent("PROJECTION_SNAPSHOT");
      expect(screen.getByTestId(`brief-${item.id}-subject`)).toHaveTextContent("as_of_sequence 7");
      expect(screen.getByTestId(`brief-${item.id}-freshness`)).toHaveTextContent("observed_at 2026-08-25T00:00:00.000Z (event refresh; 10s fallback)");
      expect(screen.getByTestId(`brief-${item.id}-status`)).not.toHaveClass("verified");
    }
    expect(screen.getByTestId("brief-fleet-next")).toHaveTextContent("open #/fleet and read it at as_of_sequence 7");
    expect(screen.getByTestId("shift-brief-summary")).toHaveTextContent(
      "durable 9 (read at a sequence 9, read unknown 0) · unknown 6 · profile availability unknown",
    );
    expect(urls.filter((url) => !url.includes("/events"))).toEqual(["/api/v1/operator-snapshot"]);
    sequence = 8;
    await act(async () => { screen.getByRole("button", { name: "Refresh snapshot" }).click(); });
    await waitFor(() => expect(screen.getByTestId("brief-fleet-subject")).toHaveTextContent("as_of_sequence 8"));
    for (const item of SURFACES.filter((item) => !ABSENT_SUBJECT_SURFACES.includes(item.id))) {
      expect(screen.getByTestId(`brief-${item.id}-subject`)).toHaveTextContent("as_of_sequence 8");
    }
    expect(screen.getByTestId("shift-brief-snapshot")).toHaveTextContent("STALE");
    expect(statusText("quota-capacity")).toBe("unknown");
    expect(screen.getByTestId("shift-brief").querySelector(".verified")).toBeNull();
  });

  it("a malformed component refuses every durable row instead of showing a partial brief", async () => {
    const malformed = operatorSnapshotFixture(5);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/api/v1/operator-snapshot")
      ? json({ ...malformed, quality_lab: { ...malformed.quality_lab, unexpected: true } }, 5)
      : new Response("no stream", { status: 404 })));
    render(<ShiftBriefPage />);
    await settled();
    expect(screen.getAllByText("NONE_UNREACHABLE")).toHaveLength(9);
    expect(screen.queryAllByText("PROJECTION_SNAPSHOT")).toHaveLength(0);
    expect(screen.getByTestId("brief-fleet-blocker")).toHaveTextContent("schema validation");
    expect(screen.getByTestId("shift-brief").querySelector(".verified")).toBeNull();
  });

  it("briefRow keeps a loading durable read unproved and never promotes an absent subject", () => {
    const loading = briefRow(surface("fleet"), { kind: "loading" });
    expect(loading.status).toBe("durable");
    expect(loading.evidence).toBe("NONE_LOADING");
    expect(loading.claim).toContain("unproved");
    expect(loading.freshness).toBe("unknown");
    const provenances: Provenance[] = [
      { kind: "loading" },
      { kind: "unknown", text: "ECONNREFUSED" },
      { kind: "value", asOf: 9, observedAt: "2026-08-25T00:00:00.000Z", source: "bullet-kernel/sqlite-ledger" },
    ];
    for (const id of ABSENT_SUBJECT_SURFACES) {
      for (const provenance of provenances) {
        const row = briefRow(surface(id), provenance);
        expect(row.status, `${id} ${provenance.kind}`).toBe("unknown");
        expect(row.statusClass, `${id} ${provenance.kind}`).toBe("unknown");
        expect(row.evidence, `${id} ${provenance.kind}`).toBe("NONE_NO_SUBJECT");
        expect(row.freshness, `${id} ${provenance.kind}`).toBe("unknown");
        for (const value of Object.values(row)) {
          expect(String(value), `${id} ${provenance.kind}`).not.toBe("");
          expect(String(value), `${id} ${provenance.kind}`).not.toContain("OUT_OF_PROFILE");
        }
      }
    }
  });
});
