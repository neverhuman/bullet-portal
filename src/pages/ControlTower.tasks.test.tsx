import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api";
import { getCodingTask } from "../codingTasks";
import { prepareCommand } from "../commandIdentity";
import { clearPendingCommand, loadPendingCommand, persistPendingCommand } from "../pendingCommand";
import { codingTaskFixture, taskEnvelopeFixture, taskSnapshotFixture } from "../testing/codingTask";
import { operatorSnapshotFixture } from "../testing/operatorSnapshot";
import { ControlTower } from "./ControlTower";

vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  fetchOperatorSnapshot: vi.fn(), fetchHealth: vi.fn(), hasSessionMaterial: vi.fn(),
  getCommand: vi.fn(), submitCommand: vi.fn(), forgetBrowserSession: vi.fn(),
}));
vi.mock("../codingTasks", async (original) => ({
  ...await original<typeof import("../codingTasks")>(), getCodingTask: vi.fn(),
}));

const envelope = taskEnvelopeFixture();
const subject = prepareCommand(envelope).subject;
const terminal = { ...subject, status: "UNKNOWN" as const, result: {} };
const recorded = { envelope, commandId: subject.id, kind: subject.kind, payloadDigest: subject.payload_digest };
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Submit durable coding command" }));

beforeEach(() => {
  vi.clearAllMocks(); clearPendingCommand();
  vi.mocked(api.hasSessionMaterial).mockReturnValue(true);
  vi.mocked(api.fetchHealth).mockResolvedValue({ status: "ok" });
  vi.mocked(api.fetchOperatorSnapshot).mockResolvedValue({ data: operatorSnapshotFixture(),
    asOfSequence: 0, observedAt: "2026-09-10T03:00:00Z", source: "bullet-kernel/sqlite-ledger" });
  vi.mocked(api.getCommand).mockResolvedValue(terminal);
  vi.mocked(api.submitCommand).mockResolvedValue(terminal);
  vi.mocked(getCodingTask).mockResolvedValue(taskSnapshotFixture());
});
afterEach(() => { cleanup(); clearPendingCommand(); });

it("journals the complete form intent before admission and displays its persisted queue blocker", async () => {
  const task = codingTaskFixture();
  vi.mocked(api.submitCommand).mockImplementation(async (sent) => {
    expect(loadPendingCommand()?.envelope).toEqual(sent);
    expect(loadPendingCommand()?.commandId).toBeNull();
    expect(sent).toEqual({ idempotency_key: expect.stringMatching(/^portal_[0-9a-f]{32}$/),
      kind: "run_coding", payload: { schema_version: "bullet.run-coding.v2", task,
        selection: { account_id: "fixture-account", provider: "cursor", model: "fixture-model", effort: "high" } } });
    vi.mocked(getCodingTask).mockResolvedValue(taskSnapshotFixture(sent));
    return { ...prepareCommand(sent).subject, status: "UNKNOWN", result: {} };
  });
  render(<ControlTower />);
  fill("Task title", task.title); fill("Objective", task.objective);
  fill("Repository ID", task.repository_id); fill("Base commit", task.base_commit);
  fill("Allowed paths (one per line)", task.scope_paths.join("\n"));
  fill("Acceptance criteria (one per line)", task.acceptance_criteria.join("\n"));
  fill("Gate IDs (one per line)", task.gate_ids.join("\n"));
  fill("Deadline (UTC)", "2100-01-01T00:00");
  fill("Account", "fixture-account"); fill("Model", "fixture-model");
  fill("Provider", "cursor"); fill("Effort (optional)", "high");
  submit();
  await waitFor(() => expect(api.submitCommand).toHaveBeenCalledOnce());
  await screen.findByText("CODING_BINDING_ADMISSION_UNAVAILABLE");
  expect(screen.getByTestId("phase")).toHaveTextContent("UNKNOWN");
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
});

it("restores every task field after response loss and refuses changed intent under the saved key", async () => {
  const payload = taskSnapshotFixture().data;
  const saved = { ...envelope, payload: { schema_version: "bullet.run-coding.v2",
    task: { ...payload.task, deadline_unix_ms: 4102444800123 }, selection: payload.selection } };
  vi.mocked(api.submitCommand).mockResolvedValue({ ...prepareCommand(saved).subject, status: "UNKNOWN", result: {} });
  persistPendingCommand({ ...recorded, envelope: saved, commandId: null, payloadDigest: null });
  render(<ControlTower />);
  expect(screen.getByLabelText("Task title")).toHaveValue(codingTaskFixture().title);
  expect(screen.getByLabelText("Allowed paths (one per line)")).toHaveValue("src\ntests");
  expect(screen.getByLabelText("Effort (optional)")).toHaveValue("high");
  expect(screen.getByLabelText("Deadline (UTC)")).toHaveValue("2100-01-01T00:00:00.123");
  expect(api.submitCommand).not.toHaveBeenCalled();
  fill("Objective", "A different goal"); submit();
  await screen.findByText(/pending command conflicts/);
  expect(api.submitCommand).not.toHaveBeenCalled();
  expect(loadPendingCommand()?.envelope).toEqual(saved);
  fill("Objective", codingTaskFixture().objective); submit();
  await waitFor(() => expect(api.submitCommand).toHaveBeenCalledExactlyOnceWith(saved));
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
});

it("reconciles a recorded v2 admission on reload without creating or posting a replacement", async () => {
  persistPendingCommand(recorded);
  render(<ControlTower />);
  await waitFor(() => expect(api.getCommand).toHaveBeenCalledExactlyOnceWith(subject.id));
  await screen.findByText("CODING_BINDING_ADMISSION_UNAVAILABLE");
  expect(getCodingTask).toHaveBeenCalledExactlyOnceWith(subject.id);
  expect(screen.getByLabelText("Base commit")).toHaveValue(codingTaskFixture().base_commit);
  expect(api.submitCommand).not.toHaveBeenCalled();
  await waitFor(() => expect(loadPendingCommand()).toBeNull());
});
