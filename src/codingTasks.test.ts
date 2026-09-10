import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, expect, it, vi } from "vitest";
import type { CodingRunView, CodingTaskContract } from "./generated/api";
import { prepareCommand } from "./commandIdentity";
import { codingTaskPayload, getCodingTask, isCodingRunView, isCodingTaskPayload, newRunCodingEnvelope } from "./codingTasks";

function task(): CodingTaskContract {
  return {
    title: "Repair retry", objective: "Preserve the same task after response loss.",
    repository_id: `rep_${"a".repeat(64)}`, base_commit: "b".repeat(40),
    scope_paths: ["src", "tests"], acceptance_criteria: ["Retry creates no second invocation."],
    gate_ids: [`gat_${"c".repeat(64)}`], dependencies: [],
    budget: { max_invocations: 2, max_cost_microusd: 5000000 }, deadline_unix_ms: 4102444800000,
  };
}
function fields() {
  return { task: task(), accountId: "fixture-account", provider: "codex" as const, model: "fixture-model", effort: "high" };
}
function view(): CodingRunView {
  const payload = codingTaskPayload(fields());
  const command = { ...prepareCommand({ idempotency_key: "fixture-task", kind: "run_coding", payload }).subject,
    status: "PENDING" as const, result: null };
  return {
    command, task: payload.task, selection: payload.selection,
    run_id: `crn_${bytesToHex(blake3(utf8ToBytes(`bullet.coding-run.v1\0${command.id}`)))}`,
    task_revision_id: `ctr_${"d".repeat(64)}`, accepted_at: "2026-09-10T12:00:00Z",
    blockers: [{ code: "CODING_BINDING_ADMISSION_UNAVAILABLE", subject: null }],
  };
}
function snapshot(data = view()) {
  return { data, as_of_sequence: 7, observed_at: "2026-09-10T12:00:01Z", source: "bullet-kernel/sqlite-ledger" };
}

vi.mock("./apiAuth", () => ({ getOperatorSession: vi.fn(async () => ({
  status: "AUTHENTICATED", operator_id: `opr_${"1".repeat(64)}`, session_id: `sid_${"2".repeat(64)}`,
  issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z",
})) }));

afterEach(() => { vi.unstubAllGlobals(); });

it("creates task intent with one fresh idempotency key and no caller execution authority", () => {
  const random = vi.fn((bytes: Uint8Array) => { expect(bytes).toHaveLength(16); bytes.fill(1); return bytes; });
  vi.stubGlobal("crypto", { getRandomValues: random });
  const requested = fields();
  const envelope = newRunCodingEnvelope(requested);
  expect(envelope).toEqual({ idempotency_key: `portal_${"01".repeat(16)}`, kind: "run_coding", payload: {
    schema_version: "bullet.run-coding.v2", task: task(),
    selection: { account_id: "fixture-account", provider: "codex", model: "fixture-model", effort: "high" },
  } });
  requested.task.title = "changed after journaling";
  expect(envelope.payload).toMatchObject({ task: { title: "Repair retry" } });
  expect(random).toHaveBeenCalledOnce();
});

it("rejects malformed task authority, UTF-8 limits, paths and missing nullable effort", () => {
  const original = codingTaskPayload(fields());
  expect(isCodingTaskPayload(original)).toBe(true);
  expect(isCodingTaskPayload({ ...original, launch_nonce: "a".repeat(64) })).toBe(false);
  expect(isCodingTaskPayload({ ...original, task: { ...task(), title: "é".repeat(121) } })).toBe(false);
  for (const path of ["../src", "/src", "src//lib.rs", "src/.GiT/config", "src\\lib.rs", "src\u001b[31m"]) {
    expect(isCodingTaskPayload({ ...original, task: { ...task(), scope_paths: [path] } })).toBe(false);
  }
  expect(isCodingTaskPayload({ ...original, task: { ...task(), gate_ids: [task().gate_ids[0], task().gate_ids[0]] } })).toBe(false);
  const { account_id, provider, model } = original.selection;
  const missingEffort = { account_id, provider, model };
  expect(isCodingTaskPayload({ ...original, selection: missingEffort })).toBe(false);
  expect(isCodingTaskPayload({ ...original, selection: { ...original.selection, effort: null } })).toBe(true);
  expect(() => codingTaskPayload({ ...fields(), model: "Unbound Model" })).toThrow("invalid");
});

it("matches Rust Unicode White_Space semantics for nonblank task text", () => {
  const original = codingTaskPayload(fields());
  expect(isCodingTaskPayload({ ...original, task: { ...task(), title: "\uFEFF" } })).toBe(true);
  for (const title of [" ", "\u0085", "\u00A0", "\u2003"]) {
    expect(isCodingTaskPayload({ ...original, task: { ...task(), title } })).toBe(false);
  }
});

it("binds every accepted task and selection field to the original digest without a browser journal", () => {
  const original = view();
  expect(isCodingRunView(original)).toBe(true);
  for (const changed of [
    { ...original, task: { ...original.task, title: "another valid task" } },
    { ...original, selection: { ...original.selection, model: "other-model" } },
    { ...original, selection: { ...original.selection, effort: null } },
    { ...original, run_id: `crn_${"e".repeat(64)}` },
    { ...original, command: { ...original.command, payload_digest: "e".repeat(64) } },
    { ...original, command: { ...original.command, result: {} } },
  ]) expect(isCodingRunView(changed)).toBe(false);
});

it("reads the exact task and its queue blocker from one authenticated snapshot", async () => {
  const body = snapshot();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "x-bullet-session-id": `sid_${"2".repeat(64)}`,
    "content-type": "application/json", "x-bullet-as-of-sequence": "7",
  } }));
  vi.stubGlobal("fetch", fetch);
  await expect(getCodingTask(body.data.command.id)).resolves.toMatchObject({ data: body.data, asOfSequence: 7 });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/v1/commands/${body.data.command.id}/coding`,
    expect.objectContaining({ credentials: "same-origin" }));
});

it("rejects substituted subjects, future acceptance and mismatched watermark headers", async () => {
  const original = snapshot();
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const [body, header, id] of [
    [original, "8", original.data.command.id],
    [{ ...original, observed_at: "2026-09-10T11:59:59Z" }, "7", original.data.command.id],
    [original, "7", `cmd_${"f".repeat(64)}`],
  ] as const) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { headers: { "x-bullet-session-id": `sid_${"2".repeat(64)}`,
      "content-type": "application/json", "x-bullet-as-of-sequence": header,
    } }));
    await expect(getCodingTask(id)).rejects.toThrow();
  }
});
