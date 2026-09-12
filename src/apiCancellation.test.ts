import { afterEach, expect, it, vi } from "vitest";
import { fetchJson, readSnapshot } from "./apiTransport";
import { getCommand, submitCommand } from "./api";
import { forgetBrowserSession, rememberCsrfToken } from "./apiSession";

afterEach(() => { forgetBrowserSession(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("binds absence before decoding and distinguishes an acknowledged command absence", async () => {
  const expected = `sid_${"1".repeat(64)}`;
  for (const observed of [null, `sid_${"2".repeat(64)}`, expected]) {
    const headers = new Headers({ "content-type": "application/problem+json" });
    if (observed !== null) headers.set("x-bullet-session-id", observed);
    const json = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, headers, json }));
    const error = await getCommand("saved", undefined, { "x-bullet-expected-session": expected }).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 404, acknowledgedSession: observed === expected ? expected : null });
    if (observed === expected) expect(json).toHaveBeenCalledOnce();
    else {
      expect(json).not.toHaveBeenCalled();
      expect(error).toMatchObject({ message: expect.stringContaining("SESSION_BINDING_REQUIRED") });
    }
  }
});

it("refuses command reads without the exact requested session acknowledgement", async () => {
  const expected = `sid_${"1".repeat(64)}`;
  for (const observed of [null, `sid_${"2".repeat(64)}`]) {
    const headers = new Headers({ "content-type": "application/json" });
    if (observed !== null) headers.set("x-bullet-session-id", observed);
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { headers }));
    vi.stubGlobal("fetch", fetch);
    await expect(getCommand("saved", undefined, { "x-bullet-expected-session": expected }))
      .rejects.toMatchObject({ outcomeUnknown: false, message: expect.stringContaining("SESSION_BINDING_REQUIRED") });
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("x-bullet-expected-session")).toBe(expected);
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: {
    "content-type": "application/json", "x-bullet-session-id": expected,
  } })));
  await expect(fetchJson("/receipt", { headers: { "x-bullet-expected-session": expected } }))
    .resolves.toMatchObject({ body: {} });
});

it("refuses a canceled mutation before dispatch without inventing an unknown effect", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const controller = new AbortController(); controller.abort();
  await expect(fetchJson("/command", { method: "POST", signal: controller.signal }))
    .rejects.toMatchObject({ outcomeUnknown: false, status: null });
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels a dispatched mutation with unknown outcome and releases its timeout and listener", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
  const request = fetchJson("/command", { method: "POST", signal: controller.signal });
  controller.abort();
  await expect(request).rejects.toMatchObject({ outcomeUnknown: true, message: "POST /command failed: request canceled" });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a late snapshot even if its transport ignores cancellation", async () => {
  const controller = new AbortController();
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  const request = readSnapshot("/snapshot", (value): value is object => typeof value === "object", controller.signal,
    { "x-bullet-expected-session": `sid_${"1".repeat(64)}` });
  controller.abort();
  resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
  await expect(request).rejects.toMatchObject({ outcomeUnknown: false, message: "GET /snapshot failed: request canceled" });
});

it("aborts pending response bodies on authentication change and preserves mutation ambiguity", async () => {
  let finish!: (value: unknown) => void;
  const body = new Promise<unknown>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202,
    headers: new Headers({ "content-type": "application/json" }), json: () => body }));
  const request = fetchJson("/commands", { method: "POST" });
  await Promise.resolve();
  rememberCsrfToken("replacement"); finish({});
  await expect(request).rejects.toMatchObject({ outcomeUnknown: true,
    message: expect.stringContaining("SESSION_CHANGED") });
});

it("keeps cancellation active through a response body and preserves mutation ambiguity", async () => {
  const controller = new AbortController();
  let finish!: (body: unknown) => void;
  const body = new Promise<unknown>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: () => body,
  }));
  const request = fetchJson("/command", { method: "POST", signal: controller.signal });
  await Promise.resolve(); controller.abort(); finish({});
  await expect(request).rejects.toMatchObject({ outcomeUnknown: true, message: "POST /command failed: request canceled" });
});

it("never submits a saved request with a replacement local session", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const original = `csrf_${"1".repeat(64)}`;
  rememberCsrfToken(`csrf_${"2".repeat(64)}`);
  await expect(submitCommand({ idempotency_key: "saved", kind: "run_demo", payload: {} }, { csrf: original }))
    .rejects.toMatchObject({ outcomeUnknown: false, message: expect.stringContaining("session changed") });
  expect(fetch).not.toHaveBeenCalled();
});

it("retains ambiguity when an error response body is canceled or times out", async () => {
  vi.useFakeTimers();
  for (const cause of ["abort", "timeout"] as const) {
    for (const delivery of ["reject", "late"] as const) {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => { entered = resolve; });
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const body = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false, status: 403, headers: new Headers({ "content-type": "application/problem+json" }),
        json: () => { entered(); return body; },
      }));
      const result = fetchJson("/command", { method: "POST", signal: controller.signal }).catch((error: unknown) => error);
      await reading;
      if (cause === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(10_001);
      if (delivery === "reject") reject(new DOMException("aborted", "AbortError"));
      else resolve({ status: 403 });
      expect(await result).toMatchObject({
        outcomeUnknown: true, status: null,
        message: `POST /command failed: ${cause === "abort" ? "request canceled" : "timeout after 10000ms"}`,
      });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    }
  }
});
