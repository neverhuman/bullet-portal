import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../apiTransport";
import { getCodingTask } from "../codingTasks";
import { taskSnapshotFixture } from "../testing/codingTask";
import { CodingTaskCard } from "./CodingTaskCard";

vi.mock("../codingTasks", async (original) => ({
  ...await original<typeof import("../codingTasks")>(), getCodingTask: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("refreshes the exact task subject and withholds stale success after an unauthorized read", async () => {
  const first = taskSnapshotFixture();
  vi.mocked(getCodingTask).mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, asOfSequence: 8,
    data: { ...first.data, command: { ...first.data.command, status: "VERIFIED", result: {} },
      blockers: [{ code: "CODING_TASK_DEADLINE_EXPIRED", subject: null }] } })
    .mockRejectedValueOnce(new ApiError("GET", "/fixture-task", 401, "expired"));
  render(<CodingTaskCard commandId={first.data.command.id} />);
  await screen.findByText("CODING_BINDING_ADMISSION_UNAVAILABLE");
  fireEvent.click(screen.getByRole("button", { name: "Refresh task" }));
  await screen.findByText("CODING_TASK_DEADLINE_EXPIRED");
  expect(screen.getByText("VERIFIED · verification receipt unchecked")).not.toHaveClass("verified");
  fireEvent.click(screen.getByRole("button", { name: "Refresh task" }));
  await screen.findByText(/Task status UNKNOWN/);
  expect(screen.queryByText(first.data.task.title)).not.toBeInTheDocument();
  await waitFor(() => expect(getCodingTask).toHaveBeenCalledTimes(3));
  for (const [id] of vi.mocked(getCodingTask).mock.calls) expect(id).toBe(first.data.command.id);
});
