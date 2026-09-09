import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeBootstrap, forgetBrowserSession, getCommand, newRunDemoEnvelope, submitCommand,
} from "./api";

const id = `cmd_${"a".repeat(64)}`;
const csrf = `csrf_${"b".repeat(64)}`;
const envelope = { idempotency_key: "portal_command_boundary", kind: "run_demo", payload: {} };
const pending = { id, status: "PENDING", kind: "run_demo", payload_digest: "c".repeat(64), result: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

async function session(response: unknown) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({ status: "AUTHENTICATED", csrf_token: csrf, expires_in_seconds: 900 }))
    .mockResolvedValueOnce(json(response, 202));
  vi.stubGlobal("fetch", fetch);
  await exchangeBootstrap("boot_command_boundary");
  return fetch;
}

afterEach(() => {
  forgetBrowserSession();
  vi.unstubAllGlobals();
});

describe("command admission boundaries", () => {
  it("refuses a command without a browser session before dispatch", async () => {
    forgetBrowserSession();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(submitCommand(envelope)).rejects.toMatchObject({
      method: "POST", url: "/api/v1/commands", status: null, outcomeUnknown: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allocates each demo idempotency subject from fresh cryptographic bytes", () => {
    let next = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      expect(bytes).toHaveLength(16);
      bytes.fill(next++ === 0 ? 0 : 255);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(newRunDemoEnvelope()).toEqual({
      idempotency_key: `portal_${"00".repeat(16)}`, kind: "run_demo", payload: {},
    });
    expect(newRunDemoEnvelope()).toEqual({
      idempotency_key: `portal_${"ff".repeat(16)}`, kind: "run_demo", payload: {},
    });
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["completed status", { ...pending, status: "APPLIED", result: {} }],
    ["different kind", { ...pending, kind: "different_command" }],
    ["premature result", { ...pending, result: {} }],
  ])("keeps a successful HTTP admission with %s unknown", async (_label, response) => {
    await session(response);
    await expect(submitCommand(envelope)).rejects.toMatchObject({
      method: "POST", status: 202, outcomeUnknown: true,
    });
  });

  it("accepts exact pending admission and later reads the matching command subject", async () => {
    const fetch = await session(pending);
    await expect(submitCommand(envelope)).resolves.toEqual(pending);
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/commands", expect.objectContaining({
      method: "POST", credentials: "same-origin", body: JSON.stringify(envelope),
      headers: expect.objectContaining({ "x-bullet-csrf": csrf }),
    }));
    const verified = { ...pending, status: "VERIFIED", result: { evidence: "PASS" } };
    fetch.mockResolvedValueOnce(json(verified));
    await expect(getCommand(id)).resolves.toEqual(verified);
    expect(fetch).toHaveBeenNthCalledWith(3, `/api/v1/commands/${id}`, expect.objectContaining({
      credentials: "same-origin",
    }));
  });
});
