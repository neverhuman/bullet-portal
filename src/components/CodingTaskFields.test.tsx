import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { codingTaskPayload } from "../codingTasks";
import { CodingTaskFields, emptyCodingTask, usdMicros } from "./CodingTaskFields";

afterEach(cleanup);

it("keeps exact decimal budgets and refuses excess precision or unsupported amounts", () => {
  expect(usdMicros("0.000001")).toBe(1);
  expect(usdMicros("1.234567")).toBe(1234567);
  expect(usdMicros("1000")).toBe(1000000000);
  for (const raw of ["0", "-1", "1e2", "1.0000001", "1000.000001", "NaN", ""]) expect(usdMicros(raw)).toBeNull();
});

it("collects explicit task scope, criteria, limits and UTC deadline without creating authority", () => {
  function Form() {
    const [task, setTask] = useState(emptyCodingTask);
    return <><CodingTaskFields value={task} onChange={setTask} /><output data-testid="draft">{JSON.stringify(task)}</output></>;
  }
  render(<Form />);
  const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fill("Task title", "Repair retry"); fill("Objective", "Preserve accepted work.");
  fill("Repository ID", `rep_${"a".repeat(64)}`); fill("Base commit", "b".repeat(40));
  fill("Allowed paths (one per line)", "src\ntests");
  fill("Acceptance criteria (one per line)", "No duplicate invocation.\nAll relevant tests pass.");
  fill("Gate IDs (one per line)", `gat_${"c".repeat(64)}`);
  fill("Budget (USD)", "1.234567"); fill("Invocation limit", "3"); fill("Deadline (UTC)", "2030-01-01T12:30");
  const task = JSON.parse(screen.getByTestId("draft").textContent!);
  expect(task.scope_paths).toEqual(["src", "tests"]);
  expect(task.budget).toEqual({ max_invocations: 3, max_cost_microusd: 1234567 });
  expect(task.deadline_unix_ms).toBe(Date.parse("2030-01-01T12:30:00Z"));
  expect(codingTaskPayload({ task, accountId: "fixture", provider: "codex", model: "fixture", effort: null }).task).toEqual(task);
});

it("displays every retained deadline millisecond including values beyond the calendar range", () => {
  const onChange = vi.fn();
  const value = { ...emptyCodingTask(), deadline_unix_ms: 4102444800123 };
  const form = render(<CodingTaskFields value={value} onChange={onChange} />);
  expect(screen.getByLabelText("Deadline (UTC)")).toHaveValue("2100-01-01T00:00:00.123");
  expect(onChange).not.toHaveBeenCalled();
  for (const milliseconds of [253402300800123, Number.MAX_SAFE_INTEGER]) {
    form.rerender(<CodingTaskFields value={{ ...value, deadline_unix_ms: milliseconds }} onChange={onChange} />);
    expect(screen.getByLabelText(/Deadline \(Unix milliseconds\)/)).toHaveValue(milliseconds);
  }
  expect(onChange).not.toHaveBeenCalled();
});
