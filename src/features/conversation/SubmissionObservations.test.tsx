import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getOperatorSession } from "../../apiAuth";
import { rememberCsrfToken } from "../../apiSession";
import { conversationEnvelope } from "./contracts";
import { listSubmissionObservationPage, recordStatus, reserveSubmission, type Submission } from "./journal";
import { applied, database, session, storage, write } from "./fixture.test-support";
import type { ConversationOwner } from "./owner";
import { SubmissionObservations } from "./SubmissionObservations";

vi.mock("../../apiAuth", () => ({ getOperatorSession: vi.fn() }));
let owner: ConversationOwner;
let row: Submission;
beforeEach(async () => {
  owner = storage(); vi.mocked(getOperatorSession).mockResolvedValue(session);
  row = await reserveSubmission(owner, conversationEnvelope("historical request", null));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("reads101 observations in bounded exclusive pages and makes every outcome accessible", async () => {
  const status = { ...applied(row), status: "PENDING" as const, result: null };
  for (let i = 0; i < 101; i += 1) await recordStatus(owner, row, status);
  const first = await listSubmissionObservationPage(owner, row);
  expect(first.observations).toHaveLength(100); expect(first.nextAfter).toBe(100);
  const last = await listSubmissionObservationPage(owner, row, first.nextAfter!);
  expect(last.observations.map((observation) => observation.sequence)).toEqual([101]); expect(last.nextAfter).toBeNull();
  render(<SubmissionObservations owner={owner} row={row} />);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show observed outcomes" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(100));
  fireEvent.click(screen.getByRole("button", { name: "Load more observed outcomes" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(101));
  expect(screen.queryByRole("button", { name: "Load more observed outcomes" })).not.toBeInTheDocument();
  expect(screen.getByText(/do not grant execution or integration authority/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh observed outcomes" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(100));
});

it("refuses malformed local outcomes and invalid cursors while preserving original bytes", async () => {
  const db = await database();
  const original = { origin: owner.origin, operatorId: owner.operatorId, commandId: row.id,
    status: { ...applied(row), id: `cmd_${"9".repeat(64)}` }, observedAt: session.issued_at };
  await write(db, "observations", 1, original);
  await expect(listSubmissionObservationPage(owner, row, -1)).rejects.toThrow("JOURNAL_INVALID");
  await expect(listSubmissionObservationPage(owner, row, Number.NaN)).rejects.toThrow("JOURNAL_INVALID");
  await expect(listSubmissionObservationPage(owner, row)).rejects.toThrow("JOURNAL_INVALID");
  render(<SubmissionObservations owner={owner} row={row} />);
  fireEvent.click(screen.getByRole("button", { name: "Show observed outcomes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("JOURNAL_INVALID");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  const retained = await new Promise((resolve) => { const get = db.transaction("observations").objectStore("observations").get(1); get.onsuccess = () => resolve(get.result); });
  expect(retained).toEqual(original); db.close();
});

it("clears observed outcomes and ignores a delayed identity result after authentication changes", async () => {
  await recordStatus(owner, row, applied(row));
  render(<SubmissionObservations owner={owner} row={row} />);
  fireEvent.click(screen.getByRole("button", { name: "Show observed outcomes" }));
  await screen.findByRole("listitem");
  let finish!: (value: typeof session) => void;
  vi.mocked(getOperatorSession).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh observed outcomes" }));
  await waitFor(() => expect(getOperatorSession).toHaveBeenCalledTimes(2));
  await act(async () => { rememberCsrfToken("new operator context"); });
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  await act(async () => { finish(session); });
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not mix another command's observations and labels an empty local history explicitly", async () => {
  const db = await database();
  await write(db, "observations", 1, { origin: owner.origin, operatorId: owner.operatorId,
    commandId: `cmd_${"9".repeat(64)}`, status: applied(row), observedAt: session.issued_at }); db.close();
  expect((await listSubmissionObservationPage(owner, row)).observations).toEqual([]);
  render(<SubmissionObservations owner={owner} row={row} />);
  fireEvent.click(screen.getByRole("button", { name: "Show observed outcomes" }));
  expect(await screen.findByText("No local outcome observations saved.")).toBeInTheDocument();
});
