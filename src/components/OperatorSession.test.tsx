import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { getOperatorSession, revokeOperatorSession } from "../apiAuth";
import { ApiError } from "../apiTransport";
import { OperatorSession } from "./OperatorSession";
import { useState } from "react";
import { clearPendingCommand, persistPendingCommand } from "../testing/pendingOwner";
import { pendingSlot } from "../testing/pendingOwner";

vi.mock("../apiAuth", () => ({ getOperatorSession: vi.fn(), revokeOperatorSession: vi.fn() }));
const identity = { operator_id: `opr_${"1".repeat(64)}`, session_id: `sid_${"2".repeat(64)}` };
beforeEach(() => { vi.resetAllMocks(); clearPendingCommand(); });

it("shows only server-observed identity and acknowledged revocation without cancelling work", async () => {
  vi.mocked(getOperatorSession).mockResolvedValue({ status: "AUTHENTICATED", ...identity, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" });
  vi.mocked(revokeOperatorSession).mockResolvedValue({ status: "REVOKED", ...identity, revoked_at: "2026-09-10T00:01:00Z" });
  const onChange = vi.fn(); render(<OperatorSession material onChange={onChange} />);
  expect(screen.queryByTestId("operator-session-identity")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Check session" }));
  expect(await screen.findByTestId("operator-session-identity")).toHaveTextContent(identity.operator_id);
  await userEvent.click(screen.getByRole("button", { name: "Revoke this session" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Durable work continues.");
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(screen.queryByTestId("operator-session-identity")).not.toBeInTheDocument();
});

it("keeps authentication material on ambiguous revoke and permits status reconciliation", async () => {
  vi.mocked(revokeOperatorSession).mockRejectedValue(new ApiError("POST", "/api/v1/auth/revoke", null, "response lost"));
  const onChange = vi.fn(); render(<OperatorSession material onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Revoke this session" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("UNKNOWN");
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Check session" })).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("recovers from response loss and a refused session without deleting the request journal", async () => {
  vi.mocked(revokeOperatorSession).mockRejectedValue(new ApiError("POST", "/api/v1/auth/revoke", null, "response lost"));
  vi.mocked(getOperatorSession).mockRejectedValue(new ApiError("GET", "/api/v1/auth/session", 401, "session invalid"));
  persistPendingCommand({ envelope: { idempotency_key: "preserved", kind: "run_demo", payload: {} }, commandId: null, kind: "run_demo", payloadDigest: null });
  const slot = pendingSlot();
  const original = window.sessionStorage.getItem(slot);
  expect(original).not.toBeNull();
  function Client() { const [material, setMaterial] = useState(true); return <OperatorSession material={material} onChange={setMaterial} />; }
  render(<Client />);
  await userEvent.click(screen.getByRole("button", { name: "Revoke this session" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("UNKNOWN");
  await userEvent.click(screen.getByRole("button", { name: "Check session" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("session invalid");
  await userEvent.click(screen.getByRole("button", { name: "Forget local credentials (does not revoke)" }));
  expect(screen.getByLabelText("One-time bootstrap token")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Server authority was not revoked");
  expect(window.sessionStorage.getItem(slot)).toBe(original);
});
