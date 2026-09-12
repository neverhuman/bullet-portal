import { discoverOwner } from "../apiOwner";
import { csrfToken, rememberCsrfToken } from "../apiSession";
import { setupOwner, identity } from "../testing/pendingOwner";
vi.mock("../apiAuth", () => ({ getOperatorSession: vi.fn(), revokeOperatorSession: vi.fn() }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, getCommand } from "../api";
import { listCommands } from "../apiCommands";
import { CommandHistory } from "./CommandHistory";
import type { CommandStatus } from "../generated/api";

vi.mock("../apiCommands", () => ({ listCommands: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), getCommand: vi.fn() }));
const command: CommandStatus = { id: `cmd_${"a".repeat(64)}`, kind: "run_coding",
  payload_digest: "b".repeat(64), status: "PENDING", result: null };
const other = { ...command, id: `cmd_${"c".repeat(64)}` };
function page(commands = [command], next: number | null = null, sequence = 9) {
  return { data: { commands, next_after: next }, asOfSequence: sequence,
    observedAt: "2026-09-10T02:00:00Z", source: "bullet-kernel/sqlite-ledger" as const };
}
beforeEach(() => { vi.resetAllMocks(); setupOwner(); vi.mocked(listCommands).mockResolvedValue(page()); vi.mocked(getCommand).mockResolvedValue(command); });
afterEach(cleanup);

it("discovers commands and reads a selected subject without inferring verification", async () => {
  render(<CommandHistory onUnauthorized={vi.fn()} />);
  const row = await screen.findByRole("button", { name: command.id });
  const verified = { ...command, status: "VERIFIED" as const, result: { secretResult: "unproven" } };
  vi.mocked(getCommand).mockResolvedValue(verified);
  fireEvent.click(row);
  expect(await screen.findByText("VERIFIED (receipt unavailable)")).toBeInTheDocument();
  expect(screen.queryByText("unproven")).not.toBeInTheDocument();
  expect(getCommand).toHaveBeenCalledWith(command.id, expect.any(AbortSignal), { "x-bullet-expected-session": identity.session_id });
});

it("preserves selection on refresh and follows the server continuation cursor", async () => {
  vi.mocked(listCommands).mockResolvedValue(page([command], 5));
  render(<CommandHistory onUnauthorized={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: command.id }));
  await screen.findByTestId("command-id");
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(getCommand).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: command.id })).toHaveAttribute("aria-pressed", "true");
  vi.mocked(listCommands).mockResolvedValue(page([other], null, 10));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("button", { name: other.id });
  expect(listCommands).toHaveBeenLastCalledWith(5, 25, expect.any(AbortSignal), expect.objectContaining({ sessionId: identity.session_id }));
  expect(screen.queryByTestId("command-id")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "First page" }));
  await waitFor(() => expect(listCommands).toHaveBeenLastCalledWith(0, 25, expect.any(AbortSignal), expect.objectContaining({ sessionId: identity.session_id })));
});

it("discards late detail responses after selecting a different command", async () => {
  vi.mocked(listCommands).mockResolvedValue(page([command, other]));
  let resolveOld!: (value: CommandStatus) => void;
  vi.mocked(getCommand).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce(other);
  render(<CommandHistory onUnauthorized={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: command.id }));
  await waitFor(() => expect(getCommand).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: other.id }));
  expect(await screen.findByTestId("command-id")).toHaveTextContent(other.id);
  await act(async () => resolveOld(command));
  expect(screen.getByTestId("command-id")).toHaveTextContent(other.id);
});

it("refuses changed selected payloads in both detail and refreshed history", async () => {
  vi.mocked(getCommand).mockResolvedValue({ ...command, payload_digest: "d".repeat(64) });
  render(<CommandHistory onUnauthorized={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: command.id }));
  expect(await screen.findByRole("alert")).toHaveTextContent("identity or payload changed");
  expect(screen.queryByTestId("command-id")).not.toBeInTheDocument();
  vi.mocked(listCommands).mockResolvedValue(page([{ ...command, payload_digest: "d".repeat(64) }]));
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("command identity or payload changed");
});

it("retains a failed read as stale and clears previous content when authorization fails", async () => {
  const unauthorized = vi.fn(); render(<CommandHistory onUnauthorized={unauthorized} />);
  fireEvent.click(await screen.findByRole("button", { name: command.id }));
  await screen.findByTestId("command-id");
  vi.mocked(listCommands).mockResolvedValueOnce(page([], null, 8));
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("watermark moved backwards");
  expect(screen.getByRole("button", { name: command.id })).toBeInTheDocument();
  expect(screen.queryByText("Reading current command…")).not.toBeInTheDocument();
  expect(getCommand).toHaveBeenCalledOnce();
  vi.mocked(listCommands).mockRejectedValueOnce(new ApiError("GET", "/api/v1/commands", 401, "expired"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(unauthorized).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: command.id })).not.toBeInTheDocument();
});

it("refuses phase regression from a page or the latest selected detail", async () => {
  const applied = { ...command, status: "APPLIED" as const, result: {} };
  vi.mocked(listCommands).mockResolvedValue(page([applied]));
  render(<CommandHistory onUnauthorized={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: command.id }));
  expect(await screen.findByRole("alert")).toHaveTextContent("phase moved backwards");
  expect(screen.queryByTestId("command-id")).not.toBeInTheDocument();
  vi.mocked(getCommand).mockResolvedValue(applied);
  fireEvent.click(screen.getByRole("button", { name: command.id }));
  await screen.findByTestId("command-id");
  vi.mocked(listCommands).mockResolvedValue(page([command], null, 10));
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("phase moved backwards");
  expect(screen.queryByText("Reading current command…")).not.toBeInTheDocument();
  expect(getCommand).toHaveBeenCalledTimes(2);
  // Selecting the retained older page cannot discard the latest observed phase.
  vi.mocked(getCommand).mockResolvedValue(command);
  fireEvent.click(screen.getByRole("button", { name: command.id }));
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  expect(screen.queryByTestId("command-id")).not.toBeInTheDocument();
});

it("ignores discovery failures arriving after the history is closed", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(listCommands).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const unauthorized = vi.fn(); const view = render(<CommandHistory onUnauthorized={unauthorized} />);
  await waitFor(() => expect(listCommands).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => reject(new ApiError("GET", "/api/v1/commands", 401, "expired")));
  expect(unauthorized).not.toHaveBeenCalled();
});


it("keeps a newer same-session selection when an older history request refuses", async () => {
  const unauthorized = vi.fn(); render(<CommandHistory onUnauthorized={unauthorized} />);
  await screen.findByRole("button", { name: command.id });
  let reject!: (error: unknown) => void;
  vi.mocked(listCommands).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(listCommands).toHaveBeenCalledTimes(2));
  await discoverOwner();
  await act(async () => { reject(new ApiError("GET", "/commands", 401, "older failure")); });
  expect(csrfToken()).toBe("fixture-csrf"); expect(unauthorized).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: command.id })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("Previous page retained");
});

it.each(["page", "detail"])("aborts and discards late %s results and clears selection/cursors on authentication change", async (kind) => {
  vi.mocked(listCommands).mockResolvedValue(page([command], 5));
  const unauthorized = vi.fn(); render(<CommandHistory onUnauthorized={unauthorized} />);
  fireEvent.click(await screen.findByRole("button", { name: command.id }));
  await screen.findByTestId("command-id");
  let finish!: () => void;
  if (kind === "page") {
    vi.mocked(listCommands).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(page([other], 8, 10)); }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listCommands).toHaveBeenCalledTimes(2));
  } else {
    vi.mocked(getCommand).mockImplementationOnce(() => new Promise((_resolve, reject) => { finish = () => reject(new ApiError("GET", "/commands", 403, "old refusal")); }));
    fireEvent.click(screen.getByRole("button", { name: command.id }));
    await waitFor(() => expect(getCommand).toHaveBeenCalledTimes(2));
  }
  const signal = kind === "page" ? vi.mocked(listCommands).mock.lastCall![2] : vi.mocked(getCommand).mock.lastCall![1];
  await act(async () => { rememberCsrfToken("new-epoch"); });
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("button", { name: command.id })).not.toBeInTheDocument();
  expect(screen.queryByTestId("command-id")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
  await act(async () => finish());
  expect(screen.queryByRole("button", { name: other.id })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(unauthorized).not.toHaveBeenCalled();
});
