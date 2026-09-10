import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { CodingRunView, CodingTaskContract, CommandEnvelope } from "../generated/api";
import { codingTaskPayload } from "../codingTasks";
import type { SnapshotRead } from "../apiTransport";
import { prepareCommand } from "../commandIdentity";

/** Synthetic subjects for component tests, never admitted execution bindings. */
export function codingTaskFixture(): CodingTaskContract {
  return {
    title: "Repair retry", objective: "Preserve accepted work after response loss.",
    repository_id: `rep_${"a".repeat(64)}`, base_commit: "b".repeat(40),
    scope_paths: ["src", "tests"], acceptance_criteria: ["Retry creates no second invocation."],
    gate_ids: [`gat_${"c".repeat(64)}`], dependencies: [],
    budget: { max_invocations: 2, max_cost_microusd: 5000000 }, deadline_unix_ms: 4102444800000,
  };
}

export function taskEnvelopeFixture(): CommandEnvelope {
  return { idempotency_key: "component-task-intent", kind: "run_coding", payload: codingTaskPayload({
    task: codingTaskFixture(), accountId: "fixture-account", provider: "cursor", model: "fixture-model", effort: "high",
  }) };
}

export function codingRunFixture(envelope = taskEnvelopeFixture()): CodingRunView {
  const payload = envelope.payload as ReturnType<typeof codingTaskPayload>;
  const command = { ...prepareCommand(envelope).subject, status: "PENDING" as const, result: null };
  return {
    command, task: payload.task, selection: payload.selection,
    run_id: `crn_${bytesToHex(blake3(utf8ToBytes(`bullet.coding-run.v1\0${command.id}`)))}`,
    task_revision_id: `ctr_${"d".repeat(64)}`, accepted_at: "2026-09-10T12:00:00Z",
    blockers: [{ code: "CODING_BINDING_ADMISSION_UNAVAILABLE", subject: null }],
  };
}

export function taskSnapshotFixture(envelope = taskEnvelopeFixture()): SnapshotRead<CodingRunView> {
  return { data: codingRunFixture(envelope), asOfSequence: 7,
    observedAt: "2026-09-10T12:00:01Z", source: "bullet-kernel/sqlite-ledger" };
}
