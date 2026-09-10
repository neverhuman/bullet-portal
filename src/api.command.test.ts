import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeBootstrap, forgetBrowserSession, getCommand, newRunCodingEnvelope, newRunDemoEnvelope,
  submitCommand,
} from "./api";
import { codingTaskFixture } from "./testing/codingTask";

const id = "cmd_4cc654254d22617b71cea4ec67a82d93063c1002ff9ffc549feda21659da1e96";
const csrf = `csrf_${"b".repeat(64)}`;
const envelope = { idempotency_key: "portal_command_boundary", kind: "run_demo", payload: {} };
const pending = { id, status: "PENDING", kind: "run_demo",
  payload_digest: "8255376a5ef33424238fe4163eb1ac32f139e1b7b5477f8d9eca54676b90ebb0", result: null };

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

  it("allocates a run_coding envelope with explicit account and model", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(1);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(newRunCodingEnvelope({
      task: codingTaskFixture(),
      accountId: "acct-local",
      provider: "antigravity",
      model: "gemini-2.5",
      effort: null,
    })).toEqual({
      idempotency_key: `portal_${"01".repeat(16)}`,
      kind: "run_coding",
      payload: {
        schema_version: "bullet.run-coding.v2", task: codingTaskFixture(),
        selection: { account_id: "acct-local", provider: "antigravity", model: "gemini-2.5", effort: null },
      },
    });
  });

  it.each([
    ["different id", { ...pending, id: `cmd_${"a".repeat(64)}` }],
    ["different kind", { ...pending, kind: "different_command" }],
    ["different digest", { ...pending, payload_digest: "c".repeat(64) }],
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
    for (const status of [201, 206]) {
      fetch.mockResolvedValueOnce(json(verified, status));
      await expect(getCommand(id)).rejects.toMatchObject({ status, outcomeUnknown: false });
    }
  });

  it("accepts the original command's current phase on exact retry after settlement", async () => {
    for (const status of ["PENDING", "APPLIED", "VERIFIED", "FAILED", "UNKNOWN"]) {
      const current = { ...pending, status, result: status === "PENDING" ? null : {} };
      const fetch = await session(current);
      await expect(submitCommand(envelope)).resolves.toEqual(current);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("correlates against the frozen bytes even if the caller changes its object while awaiting POST", async () => {
    const fetch = await session(pending);
    let reply!: (value: Response) => void;
    fetch.mockReset().mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const changed = { ...envelope, payload: {} };
    const result = submitCommand(changed);
    changed.kind = "changed_kind";
    changed.idempotency_key = "changed_key";
    changed.payload = { altered: true };
    reply(json(pending, 202));
    await expect(result).resolves.toEqual(pending);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/commands", expect.objectContaining({
      body: JSON.stringify(envelope),
    }));
  });

  it("refuses ambiguous local payloads before any mutation request", async () => {
    const fetch = await session(pending);
    fetch.mockClear();
    for (const payload of [{ value: undefined }, { value: 1.5 }, { value: "\ud800" }]) {
      await expect(submitCommand({ ...envelope, payload })).rejects.toMatchObject({
        method: "POST", status: null, outcomeUnknown: false,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
