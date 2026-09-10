import { afterEach, expect, it, vi } from "vitest";
import { listCommands } from "./apiCommands";
import { forgetBrowserSession } from "./apiSession";
import type { CommandStatus } from "./generated/api";

const command: CommandStatus = {
  id: `cmd_${"a".repeat(64)}`, kind: "run_coding", status: "PENDING",
  payload_digest: "b".repeat(64), result: null,
};
const page = {
  data: { commands: [command], next_after: 5 }, as_of_sequence: 9,
  observed_at: "2026-09-10T02:00:00Z", source: "bullet-kernel/sqlite-ledger",
};

function reply(body: unknown, watermark = "9", status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json", "x-bullet-as-of-sequence": watermark,
  } });
}

afterEach(() => { forgetBrowserSession(); vi.unstubAllGlobals(); });

it("discovers owned commands using the cookie after browser session storage loss", async () => {
  forgetBrowserSession();
  const fetch = vi.fn().mockResolvedValue(reply(page));
  vi.stubGlobal("fetch", fetch);
  await expect(listCommands(2, 10)).resolves.toEqual({
    data: page.data, asOfSequence: 9, observedAt: page.observed_at, source: page.source,
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/commands?after=2&limit=10",
    expect.objectContaining({ credentials: "same-origin" }));
  expect(fetch.mock.calls[0][1].body).toBeUndefined();
  expect(fetch.mock.calls[0][1].headers).toBeUndefined();
});

it("rejects invalid cursors and limits before issuing a request", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const [after, limit] of [[-1, 1], [1.5, 1], [Number.MAX_SAFE_INTEGER + 1, 1],
    [0, 0], [0, 101], [0, NaN], [0, 1.5]]) {
    await expect(listCommands(after, limit)).rejects.toMatchObject({ method: "GET", status: null });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects malformed, contradictory and nonadvancing discovery snapshots", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const hostiles = [
    { ...page, source: "untrusted" },
    { ...page, extra: true },
    { ...page, as_of_sequence: 8 },
    { ...page, data: { ...page.data, extra: true } },
    { ...page, data: { ...page.data, next_after: 2 } },
    { ...page, data: { ...page.data, next_after: 10 } },
    { ...page, data: { commands: [], next_after: 5 } },
    { ...page, data: { commands: [command, command], next_after: null } },
  ];
  for (const body of hostiles) {
    fetch.mockResolvedValueOnce(reply(body));
    await expect(listCommands(2)).rejects.toMatchObject({ method: "GET", status: 200 });
  }
  fetch.mockResolvedValueOnce(reply({ ...page, as_of_sequence: 1 }, "1"));
  await expect(listCommands(2)).rejects.toThrow("cursor contradicts");
  for (const status of [201, 206]) {
    fetch.mockResolvedValueOnce(reply(page, "9", status));
    await expect(listCommands(2)).rejects.toMatchObject({
      method: "GET", status, outcomeUnknown: false,
      message: expect.stringContaining(`expected HTTP 200, received HTTP ${status}`),
    });
  }
});

it("validates each current phase and refuses inconsistent command subjects", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const status of ["APPLIED", "VERIFIED", "FAILED", "UNKNOWN"] as const) {
    const current = { ...command, status, result: {} };
    fetch.mockResolvedValueOnce(reply({ ...page, data: { commands: [current], next_after: null } }));
    expect((await listCommands()).data.commands[0]).toEqual(current);
  }
  for (const current of [{ ...command, status: "APPLIED" }, { ...command, result: {} },
    { ...command, id: "wrong-id" }, { ...command, payload_digest: "wrong-digest" }]) {
    fetch.mockResolvedValueOnce(reply({ ...page, data: { commands: [current], next_after: null } }));
    await expect(listCommands()).rejects.toThrow("schema validation");
  }
});

it("enforces the requested page limit and accepts an observed empty final page", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(reply({ ...page, data: {
    commands: [command, { ...command, id: `cmd_${"c".repeat(64)}` }], next_after: null,
  } })).mockResolvedValueOnce(reply({ ...page, data: { commands: [], next_after: null } }));
  vi.stubGlobal("fetch", fetch);
  await expect(listCommands(0, 1)).rejects.toThrow("cursor contradicts");
  expect((await listCommands(9, 1)).data.commands).toEqual([]);
});

it("keeps unauthorized discovery unavailable instead of returning an empty history", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(listCommands()).rejects.toMatchObject({ method: "GET", status: 401, outcomeUnknown: false });
});
