import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchHealth, listMissions } from "./api";

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
});
