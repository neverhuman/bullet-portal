import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { API_PREFIX, PUBLIC_API_RUNTIME_REFS } from "./generated/api";
import type { CodingRunView, CodingTaskContract, CommandEnvelope, RunCodingTaskPayload } from "./generated/api";
import { compileGeneratedValidator, isCommandStatus } from "./apiValidation";
import { ApiError, readSnapshot, type SnapshotRead } from "./apiTransport";
import { canonicalCommandPayload, prepareCommand } from "./commandIdentity";

export type CodingProviderName = RunCodingTaskPayload["selection"]["provider"];
export type RunCodingFields = {
  task: CodingTaskContract;
  accountId: string;
  provider: CodingProviderName;
  model: string;
  effort: string | null;
};

const validatesPayload = compileGeneratedValidator<RunCodingTaskPayload>(PUBLIC_API_RUNTIME_REFS.RunCodingTaskPayload);
const validatesRun = compileGeneratedValidator<CodingRunView>(PUBLIC_API_RUNTIME_REFS.CodingRunView);

function text(value: string, bytes: number, multiline = false): boolean {
  return /\P{White_Space}/u.test(value) && utf8ToBytes(value).length <= bytes &&
    !/[\ud800-\udfff]/u.test(value) &&
    !Array.from(value).some((char) => /\p{Cc}/u.test(char) && !(multiline && (char === "\n" || char === "\t")));
}

/** Generated shape plus the Kernel's UTF-8 and normalized path constraints. */
export function isCodingTaskPayload(value: unknown): value is RunCodingTaskPayload {
  if (!validatesPayload(value)) return false;
  const { task, selection } = value;
  return text(task.title, 240) && text(task.objective, 8192, true) &&
    task.acceptance_criteria.every((criterion) => text(criterion, 1024, true)) &&
    task.scope_paths.every((path) => text(path, 512) && !path.includes("\\") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")) &&
    /^[a-z0-9_./-]{1,64}$/.test(selection.account_id) &&
    /^[a-z0-9_./-]{1,128}$/.test(selection.model) &&
    (selection.effort === null || /^[a-z0-9_./-]{1,32}$/.test(selection.effort));
}

export function codingTaskPayload(fields: RunCodingFields): RunCodingTaskPayload {
  // Freeze ordinary JSON before validation; accessors and serialization hooks
  // cannot change the request between the journal and the POST.
  const value: unknown = JSON.parse(canonicalCommandPayload({
    schema_version: "bullet.run-coding.v2", task: fields.task,
    selection: { account_id: fields.accountId, provider: fields.provider, model: fields.model, effort: fields.effort },
  }));
  if (!isCodingTaskPayload(value)) throw new Error("Coding task or runtime selection is invalid.");
  return value;
}

export function newRunCodingEnvelope(fields: RunCodingFields): CommandEnvelope {
  const payload = codingTaskPayload(fields);
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return { idempotency_key: `portal_${bytesToHex(bytes)}`, kind: "run_coding", payload };
}

export function isCodingRunView(value: unknown): value is CodingRunView {
  if (!validatesRun(value) || !isCommandStatus(value.command) || value.command.kind !== "run_coding") return false;
  const payload = { schema_version: "bullet.run-coding.v2", task: value.task, selection: value.selection };
  if (!isCodingTaskPayload(payload)) return false;
  const subject = prepareCommand({ idempotency_key: "projection-only", kind: "run_coding", payload }).subject;
  return subject.payload_digest === value.command.payload_digest &&
    value.run_id === `crn_${bytesToHex(blake3(utf8ToBytes(`bullet.coding-run.v1\0${value.command.id}`)))}`;
}

/** Exact owner-scoped subject, including after the browser journal is lost. */
export async function getCodingTask(id: string): Promise<SnapshotRead<CodingRunView>> {
  if (!/^cmd_[0-9a-f]{64}$/.test(id)) throw new Error("Invalid coding command identity.");
  const path = `${API_PREFIX}/commands/${id}/coding`;
  const snapshot = await readSnapshot(path, isCodingRunView);
  if (snapshot.data.command.id !== id || snapshot.asOfSequence === 0 ||
      Date.parse(snapshot.data.accepted_at) > Date.parse(snapshot.observedAt)) {
    throw new ApiError("GET", path, 200, "Coding task snapshot does not match its requested subject or observation.");
  }
  return snapshot;
}
