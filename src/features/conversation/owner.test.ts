import { afterEach, expect, it, vi } from "vitest";
import { getOperatorSession } from "../../apiAuth";
import { ApiError } from "../../apiTransport";
import { csrfToken, forgetBrowserSession, onBrowserSessionChange, rememberCsrfToken } from "../../apiSession";
import { assertOwner, discoverOwner, forgetRefusedOwner, verifyOwner } from "./owner";

vi.mock("../../apiAuth", () => ({ getOperatorSession: vi.fn() }));
const session = { status: "AUTHENTICATED" as const, operator_id: `opr_${"1".repeat(64)}`,
  session_id: `sid_${"2".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" };
afterEach(() => { forgetBrowserSession(); vi.resetAllMocks(); });

it("rejects owner discovery completed after local authentication changed", async () => {
  rememberCsrfToken("original");
  vi.mocked(getOperatorSession).mockImplementationOnce(async () => { rememberCsrfToken("new"); return session; });
  await expect(discoverOwner()).rejects.toThrow("CONVERSATION_OWNER_CHANGED");
});

it("invalidates old contexts even when authentication reuses the same token", async () => {
  rememberCsrfToken("original"); vi.mocked(getOperatorSession).mockResolvedValue(session);
  const owner = await discoverOwner();
  const changed = vi.fn(); const unsubscribe = onBrowserSessionChange(changed);
  rememberCsrfToken("original");
  expect(() => assertOwner(owner)).toThrow("CONVERSATION_OWNER_CHANGED");
  expect(changed).toHaveBeenCalledTimes(1); unsubscribe();
});

it("rejects cookie owner or session replacement during revalidation", async () => {
  for (const replacement of [{ ...session, operator_id: `opr_${"3".repeat(64)}` },
    { ...session, session_id: `sid_${"4".repeat(64)}` }]) {
    rememberCsrfToken("original"); vi.mocked(getOperatorSession).mockResolvedValue(session);
    const owner = await discoverOwner();
    vi.mocked(getOperatorSession).mockResolvedValueOnce(replacement);
    await expect(verifyOwner(owner)).rejects.toThrow("CONVERSATION_OWNER_CHANGED");
    expect(csrfToken()).toBeNull();
  }
});

it("refuses silent cookie replacement discovered by another projection", async () => {
  rememberCsrfToken("original"); vi.mocked(getOperatorSession).mockResolvedValue(session);
  const owner = await discoverOwner();
  vi.mocked(getOperatorSession).mockResolvedValueOnce({ ...session, session_id: `sid_${"4".repeat(64)}` });
  await expect(discoverOwner()).rejects.toThrow("CONVERSATION_OWNER_CHANGED");
  expect(() => assertOwner(owner)).toThrow("CONVERSATION_OWNER_CHANGED");
  expect(csrfToken()).toBeNull();
});

it("does not forget a newer session on a delayed authorization failure", async () => {
  rememberCsrfToken("original"); vi.mocked(getOperatorSession).mockResolvedValue(session);
  const owner = await discoverOwner(); rememberCsrfToken("new");
  forgetRefusedOwner(owner, new ApiError("GET", "/thread", 401, "expired"));
  expect(csrfToken()).toBe("new");
  const current = await discoverOwner();
  forgetRefusedOwner(current, new ApiError("GET", "/thread", 403, "refused"));
  expect(csrfToken()).toBeNull();
});

it("does not clear a later selected owner when an earlier discovery completes", async () => {
  for (const failure of [true, false]) {
    rememberCsrfToken("original");
    let resolve!: (value: typeof session) => void;
    let reject!: (reason: unknown) => void;
    vi.mocked(getOperatorSession).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const older = discoverOwner();
    const refused = expect(older).rejects.toThrow();
    vi.mocked(getOperatorSession).mockResolvedValueOnce(session);
    const current = await discoverOwner();
    if (failure) reject(new ApiError("GET", "/auth/session", 401, "old request"));
    else resolve({ ...session, session_id: `sid_${"4".repeat(64)}` });
    await refused;
    expect(csrfToken()).toBe("original");
    expect(() => assertOwner(current)).not.toThrow();
  }
});

it("does not clear a later validated context on an older projection refusal", async () => {
  rememberCsrfToken("original"); vi.mocked(getOperatorSession).mockResolvedValue(session);
  const older = await discoverOwner();
  const newer = await discoverOwner();
  forgetRefusedOwner(older, new ApiError("GET", "/snapshot", 401, "old read"));
  expect(csrfToken()).toBe("original");
  expect(() => assertOwner(newer)).not.toThrow();
});

it("keeps concurrent same-session reads live and renewal tokens immutable", async () => {
  rememberCsrfToken("original"); vi.mocked(getOperatorSession).mockResolvedValue(session);
  const [first, second] = await Promise.all([discoverOwner(), discoverOwner()]);
  expect(() => assertOwner(first)).not.toThrow();
  expect(() => assertOwner(second)).not.toThrow();
  const firstSelection = first.selection;
  const renewed = await verifyOwner(first);
  expect(renewed).not.toBe(first);
  expect(first.selection).toBe(firstSelection);
  forgetRefusedOwner(first, new ApiError("GET", "/snapshot", 401, "earlier read"));
  expect(csrfToken()).toBe("original");
  expect(() => assertOwner(renewed)).not.toThrow();
  forgetRefusedOwner(renewed, new ApiError("GET", "/snapshot", 403, "current refusal"));
  expect(csrfToken()).toBeNull();
});
