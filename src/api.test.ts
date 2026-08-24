import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchHealth, fetchReady, listMissions, runDemo } from "./api";

const OBSERVED_AT = "2026-08-24T22:00:00.000Z";

function snapshot(data: unknown, sequence = 42): Record<string, unknown> {
  return {
    data,
    as_of_sequence: sequence,
    observed_at: OBSERVED_AT,
    source: "bullet-kernel/sqlite-ledger",
  };
}

function jsonResponse(body: unknown, sequenceHeader: string | null = "42"): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (sequenceHeader !== null) {
    headers.set("x-bullet-as-of-sequence", sequenceHeader);
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("api transport honesty", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts a hung request after 10s with a typed timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const outcome = fetchHealth().then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("GET /health failed: timeout after 10000ms");
    expect((err as ApiError).status).toBeNull();
  });

  it("keeps the timeout active through a hung HTTP 200 response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        } as Response),
      ),
    );
    const outcome = runDemo().then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      "POST /v1/demo/run failed: timeout after 10000ms",
    );
    expect((err as ApiError).status).toBeNull();
  });

  it("rejects non-JSON bodies with the content type named", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        ),
      ),
    );
    await expect(listMissions()).rejects.toThrowError(
      "GET /v1/missions failed: unexpected content-type text/html",
    );
  });

  it("rejects a deceptive HTTP 200 media type even when its body is valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("[]", {
            status: 200,
            headers: { "content-type": "text/application/json-shadow" },
          }),
        ),
      ),
    );
    await expect(listMissions()).rejects.toThrowError(
      "GET /v1/missions failed: unexpected content-type text/application/json-shadow",
    );
  });

  it("accepts the exact JSON media type with case-insensitive parameters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(snapshot([])), {
            status: 200,
            headers: {
              "content-type": "Application/JSON; Charset=UTF-8",
              "x-bullet-as-of-sequence": "42",
            },
          }),
        ),
      ),
    );
    await expect(listMissions()).resolves.toEqual({
      data: [],
      asOfSequence: 42,
      observedAt: OBSERVED_AT,
      source: "bullet-kernel/sqlite-ledger",
    });
  });

  it("carries method, url, and status on HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("down", { status: 503 }))),
    );
    const err = await listMissions().then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.method).toBe("GET");
    expect(err?.url).toBe("/v1/missions");
    expect(err?.status).toBe(503);
    expect(err?.message).toBe("GET /v1/missions failed: HTTP 503");
  });

  it("returns a validated snapshot watermark without inferring one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(snapshot([])),
        ),
      ),
    );
    await expect(listMissions()).resolves.toEqual({
      data: [],
      asOfSequence: 42,
      observedAt: OBSERVED_AT,
      source: "bullet-kernel/sqlite-ledger",
    });
  });

  it("rejects a successful snapshot when the required watermark header is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(snapshot([]), null),
        ),
      ),
    );
    await expect(listMissions()).rejects.toThrowError(
      "GET /v1/missions failed: snapshot watermark header is missing",
    );
  });

  it("rejects a schema-invalid JSON snapshot even when HTTP and watermark look successful", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(snapshot({ not: "a mission list" })),
        ),
      ),
    );
    await expect(listMissions()).rejects.toThrowError(
      "GET /v1/missions failed: snapshot body failed schema validation",
    );
  });

  it("rejects malformed JSON on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("[", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-bullet-as-of-sequence": "42",
            },
          }),
        ),
      ),
    );
    await expect(listMissions()).rejects.toThrowError(
      "GET /v1/missions failed: invalid JSON body",
    );
  });

  it("marks an invalid HTTP 200 mutation receipt as an unknown outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const err = await runDemo().then(
      () => null,
      (value: unknown) => value as ApiError,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(200);
    expect(err?.outcomeUnknown).toBe(true);
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
        "GET /v1/missions failed: snapshot body failed schema validation",
      );
    }
  });

  it("rejects malformed or mismatched snapshot watermark headers", async () => {
    for (const header of ["", "-1", "+42", "042", "1.5", "9007199254740992"]) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(snapshot([]), header))));
      await expect(listMissions()).rejects.toThrowError(
        "GET /v1/missions failed: snapshot watermark header is invalid",
      );
    }
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(snapshot([]), "41"))));
    await expect(listMissions()).rejects.toThrowError(
      "GET /v1/missions failed: snapshot watermark header/body mismatch",
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
    await expect(fetchReady()).rejects.toThrowError("GET /v1/ready failed: HTTP 404");
  });

  it("keeps health and demo mutation on their non-snapshot JSON contracts", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ status: "ok" }, null))));
    await expect(fetchHealth()).resolves.toEqual({ status: "ok" });

    const receipt = {
      mission_id: "mis_demo",
      plan_hash: "abc",
      fence_first: 1,
      attempt_id: "atm_first",
      fence_second: 2,
      attempt_second_id: "atm_second",
      stale_attempt_id: "atm_first",
      candidate_head: "b".repeat(40),
      evidence_result: "PASS",
      effect_outcome: "verified",
      effect_unknown_outcome: "unknown",
      materialize_idempotent: true,
      stale_refused: true,
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(receipt, null))));
    await expect(runDemo()).resolves.toEqual(receipt);
  });
});
