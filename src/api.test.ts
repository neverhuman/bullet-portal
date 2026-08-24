import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchHealth, listMissions, runDemo } from "./api";

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
          new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-bullet-as-of-sequence": "42",
            },
          }),
        ),
      ),
    );
    await expect(listMissions()).resolves.toEqual({ data: [], asOfSequence: 42 });
  });

  it("keeps the watermark unknown when the server omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    await expect(listMissions()).resolves.toEqual({ data: [], asOfSequence: null });
  });

  it("rejects a schema-invalid JSON snapshot even when HTTP and watermark look successful", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response('{"not":"a mission list"}', {
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
      "GET /v1/missions failed: response body failed schema validation",
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
});
