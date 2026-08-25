import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiBase,
  exchangeBootstrap,
  fetchHealth,
  forgetBrowserSession,
  getCommand,
  listMissions,
  submitCommand,
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

const commandId = `cmd_${"a".repeat(64)}`;
const commandDigest = "b".repeat(64);
const csrfToken = `csrf_${"c".repeat(64)}`;

function command(status: string, result: unknown = null): Record<string, unknown> {
  return {
    id: commandId,
    status,
    kind: "run_demo",
    payload_digest: commandDigest,
    result,
  };
}

describe("api transport honesty", () => {
  afterEach(() => {
    forgetBrowserSession();
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
    const outcome = getCommand(commandId).then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      `GET /api/v1/commands/${commandId} failed: timeout after 10000ms`,
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
      "GET /api/v1/missions failed: unexpected content-type text/html",
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
      "GET /api/v1/missions failed: unexpected content-type text/application/json-shadow",
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
    expect(err?.url).toBe("/api/v1/missions");
    expect(err?.status).toBe(503);
    expect(err?.message).toBe("GET /api/v1/missions failed: HTTP 503");
  });

  it("preserves typed Problem Details and repair guidance", async () => {
    const problem = {
      type: "https://bullet.farm/problems/csrf-invalid",
      title: "Invalid CSRF token",
      status: 403,
      detail: "The CSRF token is not bound to the active browser session.",
      instance: "urn:bullet:request:req_deadbeefdeadbeef",
      code: "CSRF_INVALID",
      request_id: "req_deadbeefdeadbeef",
      correlation_id: "corr_deadbeefdeadbeef",
      retryable: false,
      repair: "Restart farmd and exchange its new one-time bootstrap token.",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(problem), {
            status: 403,
            headers: { "content-type": "application/problem+json" },
          }),
        ),
      ),
    );
    const err = await listMissions().then(
      () => null,
      (error: unknown) => error as ApiError,
    );
    expect(err).toMatchObject({
      status: 403,
      code: "CSRF_INVALID",
      requestId: "req_deadbeefdeadbeef",
      repair: problem.repair,
    });
    expect(err?.message).toContain("Repair: Restart farmd");
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
      "GET /api/v1/missions failed: snapshot watermark header is missing",
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
      "GET /api/v1/missions failed: snapshot body failed schema validation",
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
      "GET /api/v1/missions failed: invalid JSON body",
    );
  });

  it("marks an invalid HTTP 202 command subject as an unknown outcome", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: "AUTHENTICATED", csrf_token: csrfToken, expires_in_seconds: 900 },
          null,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({}, null, 202));
    vi.stubGlobal("fetch", fetchMock);
    await exchangeBootstrap("boot_fixture");
    const err = await submitCommand({
      idempotency_key: "portal_fixture",
      kind: "run_demo",
      payload: {},
    }).then(
      () => null,
      (value: unknown) => value as ApiError,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(202);
    expect(err?.outcomeUnknown).toBe(true);
  });

  it("requires exact HTTP 202 and sends the session-bound CSRF token", async () => {
    expect(apiBase).toBe("");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: "AUTHENTICATED", csrf_token: csrfToken, expires_in_seconds: 900 },
          null,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(command("PENDING"), null, 202));
    vi.stubGlobal("fetch", fetchMock);
    await exchangeBootstrap("boot_fixture");
    await expect(
      submitCommand({ idempotency_key: "portal_fixture", kind: "run_demo", payload: {} }),
    ).resolves.toEqual(command("PENDING"));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/commands",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "x-bullet-csrf": csrfToken }),
      }),
    );

    fetchMock.mockResolvedValueOnce(jsonResponse(command("PENDING"), null, 200));
    await expect(
      submitCommand({ idempotency_key: "portal_second", kind: "run_demo", payload: {} }),
    ).rejects.toMatchObject({ outcomeUnknown: true, status: 200 });
  });

  it("classifies a command-admission timeout as UNKNOWN", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: "AUTHENTICATED", csrf_token: csrfToken, expires_in_seconds: 900 },
          null,
        ),
      )
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await exchangeBootstrap("boot_fixture");
    const outcome = submitCommand({
      idempotency_key: "portal_timeout",
      kind: "run_demo",
      payload: {},
    }).then(
      () => null,
      (error: unknown) => error as ApiError,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(outcome).resolves.toMatchObject({
      outcomeUnknown: true,
      status: null,
      message: "POST /api/v1/commands failed: timeout after 10000ms",
    });
  });

  it("does not accept a mismatched command id or invented status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...command("VERIFIED", { evidence: "PASS" }),
              id: `cmd_${"d".repeat(64)}`,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      ),
    );
    await expect(getCommand(commandId)).rejects.toThrowError(
      "command response id does not match the requested subject",
    );
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(command("SUCCEEDED"), null))));
    await expect(getCommand(commandId)).rejects.toThrowError(
      "response body failed schema validation",
    );
  });

  it("rejects legacy-width and uppercase command subjects", async () => {
    for (const id of [`cmd_${"a".repeat(32)}`, `cmd_${"A".repeat(64)}`]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(jsonResponse({ ...command("PENDING"), id }, null))),
      );
      await expect(getCommand(commandId)).rejects.toThrowError(
        "response body failed schema validation",
      );
    }
  });

});
