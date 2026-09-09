import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById, type Surface } from "../surfaces";
import { MergeRailPage } from "./MergeRailPage";

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

const empty = {
  candidates: [],
  effects: [],
  intents: [],
  receipts: [],
  intent_state_counts: [{ label: "OUTCOME_UNKNOWN", count: 0 }, { label: "COMMITTED", count: 0 }],
};

const populated = {
  candidates: [
    {
      id: id("can", "7"),
      attempt_id: id("atm", "2"),
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
      patch_digest: "d".repeat(64),
    },
  ],
  effects: [{ id: id("efi", "a"), attempt_id: id("atm", "2"), logical_key: "scm:push:x", desired: "candidate-ref-exists", outcome: "unknown" }],
  intents: [
    {
      id: id("efi", "8"),
      logical_effect_key: "push:x",
      provider: "local-bare",
      target_identity: "refs/heads/x",
      desired_state_hash: "b".repeat(40),
      expected_old_oid: "0".repeat(40),
      attempt_id: id("atm", "2"),
      fence: 1,
      policy_version: "policy-v1",
      payload_hash: "e".repeat(64),
      provider_idempotency_key: null,
      state: "OUTCOME_UNKNOWN",
      unknown_retries: 1,
      created_at: "2026-08-25T00:00:00.000Z",
    },
  ],
  receipts: [
    {
      id: id("efr", "9"),
      effect_intent_id: id("efi", "8"),
      observed_remote_identity: "refs/heads/x",
      observed_state_hash: null,
      verification_method: "read-back",
      verification_result: "ABSENT",
      adopted_after_unknown: false,
      recorded_at: "2026-08-25T00:00:01.000Z",
    },
  ],
  intent_state_counts: [{ label: "OUTCOME_UNKNOWN", count: 1 }, { label: "COMMITTED", count: 0 }],
};

describe("MergeRailPage", () => {
  it("renders unknown when farmd is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    render(<MergeRailPage surface={surface("merge-rail")} />);
    await waitFor(() => {
      expect(screen.getByTestId("merge-rail-unknown")).toHaveTextContent(
        "unknown: Merge Rail: control plane unreachable (GET /api/v1/merge-rail failed: ECONNREFUSED)",
      );
    });
    expect(screen.queryByText("No merges yet.")).toBeNull();
  });

  it("renders an empty rail as zero rows verified at the watermark with every state explicit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(empty, "11")));
    render(<MergeRailPage surface={surface("merge-rail")} />);
    await waitFor(() => {
      expect(screen.getByTestId("merge-rail-candidates-empty")).toHaveTextContent(
        "candidates: 0 rows (verified at sequence 11)",
      );
    });
    for (const table of ["intents", "receipts", "effects"]) {
      expect(screen.getByTestId(`merge-rail-${table}-empty`)).toHaveTextContent("0 rows (verified at sequence 11)");
    }
    expect(screen.getByTestId("merge-rail-states-rows")).toHaveTextContent("OUTCOME_UNKNOWN");
    expect(screen.getByTestId("merge-rail-summary")).toHaveTextContent("OUTCOME_UNKNOWN 0");
    expect(screen.getByTestId("surface-merge-rail").querySelector(".verified")).toBeNull();
  });

  it("renders candidates, intents, receipts, and first-slice effects verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(populated)));
    render(<MergeRailPage surface={surface("merge-rail")} />);
    await waitFor(() => {
      expect(screen.getByTestId("merge-rail-candidates-rows")).toHaveTextContent("b".repeat(40));
    });
    expect(screen.getByTestId("merge-rail-intents-rows")).toHaveTextContent("OUTCOME_UNKNOWN");
    expect(screen.getByTestId("merge-rail-intents-rows")).toHaveTextContent("none");
    expect(screen.getByTestId("merge-rail-receipts-rows")).toHaveTextContent("ABSENT");
    expect(screen.getByTestId("merge-rail-receipts-rows")).toHaveTextContent("absent");
    expect(screen.getByTestId("merge-rail-effects-rows")).toHaveTextContent("unknown");
    expect(screen.getByTestId("merge-rail-summary")).toHaveTextContent(
      "candidates 1 · intents 1 · receipts 1 · first-slice effects 1 · OUTCOME_UNKNOWN 1",
    );
  });
});
