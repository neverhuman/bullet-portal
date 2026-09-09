import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchContextLineage,
  fetchHealth,
  fetchReady,
  forgetBrowserSession,
  listMissions,
} from "./api";

const OBSERVED_AT = "2026-08-24T22:00:00.000Z";

function snapshot(data: unknown, sequence = 42): Record<string, unknown> {
  return {
    data,
    as_of_sequence: sequence,
    observed_at: OBSERVED_AT,
    source: "bullet-kernel/sqlite-ledger",
  };
}

function jsonResponse(
  body: unknown,
  sequenceHeader: string | null = "42",
  status = 200,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (sequenceHeader !== null) {
    headers.set("x-bullet-as-of-sequence", sequenceHeader);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

describe("api snapshot transport honesty", () => {
  afterEach(() => {
    forgetBrowserSession();
    vi.unstubAllGlobals();
  });

  it("rejects malformed or non-authoritative snapshot envelope fields", async () => {
    const cases = [
      { ...snapshot([]), source: "portal/local" },
      { ...snapshot([]), observed_at: "not-rfc3339" },
      { ...snapshot([]), observed_at: "2026-02-30T00:00:00Z" },
      { ...snapshot([]), as_of_sequence: -1 },
      { ...snapshot([]), as_of_sequence: 1.5 },
      { ...snapshot([]), as_of_sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...snapshot([]), optimistic: true },
      { data: [], as_of_sequence: 42, observed_at: OBSERVED_AT },
    ];
    for (const body of cases) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(body))));
      await expect(listMissions()).rejects.toThrowError(
        "GET /api/v1/missions failed: snapshot body failed schema validation",
      );
    }
  });

  it("rejects malformed or mismatched snapshot watermark headers", async () => {
    for (const header of ["", "-1", "+42", "042", "1.5", "9007199254740992"]) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(snapshot([]), header))));
      await expect(listMissions()).rejects.toThrowError(
        "GET /api/v1/missions failed: snapshot watermark header is invalid",
      );
    }
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(snapshot([]), "41"))));
    await expect(listMissions()).rejects.toThrowError(
      "GET /api/v1/missions failed: snapshot watermark header/body mismatch",
    );
  });

  it("treats ready data null as verified empty and never infers empty from 404", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(snapshot(null)))));
    await expect(fetchReady()).resolves.toEqual({
      data: null,
      asOfSequence: 42,
      observedAt: OBSERVED_AT,
      source: "bullet-kernel/sqlite-ledger",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("missing", { status: 404 }))),
    );
    await expect(fetchReady()).rejects.toThrowError("GET /api/v1/ready failed: HTTP 404");
  });

  it("fetches only the exact Context Lineage snapshot contract", async () => {
    const capsule = {
      schema_version: "bullet.context-capsule.initial.v1",
      id: `ctx_${"1".repeat(64)}`,
      mission_id: `mis_${"2".repeat(64)}`,
      work_package_id: `wpk_${"3".repeat(64)}`,
      plan_revision_id: `pln_${"4".repeat(64)}`,
      revision: 1,
      parent_id: null,
      task_class: "security_analysis",
      objective_digest: "5".repeat(64),
      package_title_digest: "6".repeat(64),
      content_digest: "7".repeat(64),
      compression: "none",
      dropped_decision_digests: [],
      recorded_at: OBSERVED_AT,
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(snapshot({ capsules: [capsule] }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchContextLineage()).resolves.toEqual({
      data: { capsules: [capsule] },
      asOfSequence: 42,
      observedAt: OBSERVED_AT,
      source: "bullet-kernel/sqlite-ledger",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/context-lineage",
      expect.objectContaining({ credentials: "same-origin" }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(snapshot({ capsules: [{ ...capsule, objective: "raw data" }] })),
        ),
      ),
    );
    await expect(fetchContextLineage()).rejects.toThrowError(
      "GET /api/v1/context-lineage failed: snapshot body failed schema validation",
    );
  });

  it("keeps health on its non-snapshot JSON contract", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ status: "ok" }, null))));
    await expect(fetchHealth()).resolves.toEqual({ status: "ok" });
  });
});
