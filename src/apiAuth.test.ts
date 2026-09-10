import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getOperatorSession, revokeOperatorSession } from "./apiAuth";
import { csrfToken, forgetBrowserSession, rememberCsrfToken } from "./apiSession";

const csrf = `csrf_${"b".repeat(64)}`;
const identity = { operator_id: `opr_${"1".repeat(64)}`, session_id: `sid_${"2".repeat(64)}` };
const session = { status: "AUTHENTICATED", ...identity, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" };
const revoked = { status: "REVOKED", ...identity, revoked_at: "2026-09-10T00:01:00Z" };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => rememberCsrfToken(csrf));
afterEach(() => { forgetBrowserSession(); vi.unstubAllGlobals(); });

it("revokes the exact observed session through same-origin cookie and CSRF", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(revoked));
  vi.stubGlobal("fetch", fetch);
  await expect(revokeOperatorSession()).resolves.toEqual(revoked);
  expect(fetch.mock.calls[0]).toEqual(["/api/v1/auth/session", expect.objectContaining({ credentials: "same-origin", cache: "no-store" })]);
  expect(fetch.mock.calls[1]).toEqual(["/api/v1/auth/revoke", expect.objectContaining({ credentials: "same-origin", method: "POST", body: "{}", headers: { "content-type": "application/json", "x-bullet-csrf": csrf } })]);
  expect(csrfToken()).toBeNull();
});

it("refuses malformed and contradictory session identities before mutation", async () => {
  for (const value of [{ ...session, extra: true }, { ...session, session_id: "wrong" }, { ...session, expires_at: session.issued_at }, { ...session, expires_at: "2026-09-10T08:00:01Z" }, { ...session, issued_at: "2026-09-10T00:00:60Z" }]) {
    const fetch = vi.fn().mockResolvedValue(json(value)); vi.stubGlobal("fetch", fetch);
    await expect(revokeOperatorSession()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(csrfToken()).toBe(csrf);
  }
});

it("retains recovery material for lost, malformed and foreign revocation replies", async () => {
  for (const value of [null, {}, { ...revoked, operator_id: `opr_${"3".repeat(64)}` }, { ...revoked, session_id: `sid_${"3".repeat(64)}` }, { ...revoked, revoked_at: "2026-09-09T00:00:00Z" }, { ...revoked, revoked_at: session.expires_at }, { ...revoked, revoked_at: "2026-09-10T00:01:60Z" }]) {
    const fetch = vi.fn().mockResolvedValueOnce(json(session));
    if (value === null) fetch.mockRejectedValueOnce(new Error("connection lost"));
    else fetch.mockResolvedValueOnce(json(value));
    vi.stubGlobal("fetch", fetch);
    await expect(revokeOperatorSession()).rejects.toMatchObject({ outcomeUnknown: true });
    expect(csrfToken()).toBe(csrf);
  }
});

it("preserves a newer local session established while revocation was pending", async () => {
  const newer = `csrf_${"c".repeat(64)}`;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(session)).mockImplementationOnce(async () => {
    rememberCsrfToken(newer); return json(revoked);
  }));
  await expect(revokeOperatorSession()).rejects.toMatchObject({ outcomeUnknown: true });
  expect(csrfToken()).toBe(newer);
});

it("allows read-only session discovery without local CSRF but refuses revocation", async () => {
  forgetBrowserSession();
  const fetch = vi.fn().mockResolvedValue(json(session)); vi.stubGlobal("fetch", fetch);
  await expect(getOperatorSession()).resolves.toEqual(session);
  await expect(revokeOperatorSession()).rejects.toMatchObject({ outcomeUnknown: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});
