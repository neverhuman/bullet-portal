import { useEffect, useState } from "react";
import type { CodingTaskContract } from "../generated/api";

export function emptyCodingTask(): CodingTaskContract {
  return {
    title: "", objective: "", repository_id: "", base_commit: "", scope_paths: [],
    acceptance_criteria: [], gate_ids: [], dependencies: [],
    budget: { max_invocations: 2, max_cost_microusd: 5000000 },
    deadline_unix_ms: Math.ceil((Date.now() + 3600000) / 60000) * 60000,
  };
}

/** Preserve six decimal places without floating-point currency arithmetic. */
export function usdMicros(raw: string): number | null {
  if (!/^\d{1,4}(?:\.\d{0,6})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const value = Number(whole) * 1000000 + Number(fraction.padEnd(6, "0"));
  return value >= 1 && value <= 1000000000 ? value : null;
}

function BudgetField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [raw, setRaw] = useState(String(value / 1000000));
  useEffect(() => { setRaw((current) => (usdMicros(current) ?? 0) === value ? current : String(value / 1000000)); }, [value]);
  return <label>Budget (USD)
    <input inputMode="decimal" value={raw} onChange={(event) => {
      setRaw(event.target.value); onChange(usdMicros(event.target.value) ?? 0);
    }} aria-invalid={usdMicros(raw) === null} />
  </label>;
}

const nonemptyLines = (raw: string) => raw.split("\n").filter((line) => line !== "");
function LineList({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  const [raw, setRaw] = useState(value.join("\n"));
  useEffect(() => { setRaw((current) => nonemptyLines(current).join("\n") === value.join("\n") ? current : value.join("\n")); }, [value]);
  return <label>{label}<textarea rows={3} value={raw} onChange={(event) => {
    setRaw(event.target.value); onChange(nonemptyLines(event.target.value));
  }} /></label>;
}

export function CodingTaskFields({ value, onChange, disabled = false }: {
  value: CodingTaskContract; onChange: (task: CodingTaskContract) => void; disabled?: boolean;
}) {
  const set = <K extends keyof CodingTaskContract>(key: K, next: CodingTaskContract[K]) => onChange({ ...value, [key]: next });
  const deadline = new Date(value.deadline_unix_ms);
  return <fieldset disabled={disabled}>
    <legend>Task details</legend>
    <p>Define the work, its exact starting point and how it will be checked.</p>
    <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}>
      <label>Task title<input value={value.title} onChange={(event) => set("title", event.target.value)} /></label>
      <label>Repository ID<input value={value.repository_id} onChange={(event) => set("repository_id", event.target.value)} /></label>
      <label>Base commit<input value={value.base_commit} onChange={(event) => set("base_commit", event.target.value)} /></label>
      <label>Objective<textarea rows={3} value={value.objective} onChange={(event) => set("objective", event.target.value)} /></label>
      <LineList label="Allowed paths (one per line)" value={value.scope_paths} onChange={(next) => set("scope_paths", next)} />
      <LineList label="Acceptance criteria (one per line)" value={value.acceptance_criteria} onChange={(next) => set("acceptance_criteria", next)} />
      <LineList label="Gate IDs (one per line)" value={value.gate_ids} onChange={(next) => set("gate_ids", next)} />
      <LineList label="Dependency task IDs (one per line)" value={value.dependencies} onChange={(next) => set("dependencies", next)} />
      <label>Invocation limit<input type="number" min={1} max={16} step={1} value={value.budget.max_invocations}
        onChange={(event) => set("budget", { ...value.budget, max_invocations: Number(event.target.value) })} /></label>
      <BudgetField value={value.budget.max_cost_microusd} onChange={(max_cost_microusd) => set("budget", { ...value.budget, max_cost_microusd })} />
      {Number.isFinite(deadline.getTime()) && deadline.getUTCFullYear() <= 9999 ?
        <label>Deadline (UTC)<input type="datetime-local" step="0.001"
          value={value.deadline_unix_ms > 0 ? deadline.toISOString().replace(/Z$/, "") : ""}
          onChange={(event) => set("deadline_unix_ms", Date.parse(`${event.target.value}Z`) || 0)} /></label> :
        <label>Deadline (Unix milliseconds)<input type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1}
          value={value.deadline_unix_ms} onChange={(event) => set("deadline_unix_ms", Number(event.target.value))} />
          This saved deadline is outside the calendar display range.</label>}
    </div>
  </fieldset>;
}
