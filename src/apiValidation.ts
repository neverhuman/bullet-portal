import type {
  BootstrapResponse,
  CommandStatus,
  DemoReceipt,
  Health,
  Mission,
  MissionView,
  OutboxItem,
  OutboxView,
  Problem,
  ReadyView,
  WorkPackage,
} from "./generated/api";

export type ResponseValidator<T> = (value: unknown) => value is T;

export const SNAPSHOT_SOURCE = "bullet-kernel/sqlite-ledger" as const;

export type SnapshotEnvelope<T> = {
  data: T;
  as_of_sequence: number;
  observed_at: string;
  source: typeof SNAPSHOT_SOURCE;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const RFC3339 = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = RFC3339.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isSnapshotEnvelope<T>(
  value: unknown,
  validateData: ResponseValidator<T>,
): value is SnapshotEnvelope<T> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["as_of_sequence", "data", "observed_at", "source"]) &&
    validateData(value.data) &&
    isInteger(value.as_of_sequence) &&
    value.as_of_sequence >= 0 &&
    isRfc3339(value.observed_at) &&
    value.source === SNAPSHOT_SOURCE
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export const isHealth: ResponseValidator<Health> = (value): value is Health =>
  isRecord(value) && typeof value.status === "string";

export const isMission: ResponseValidator<Mission> = (value): value is Mission =>
  isRecord(value) &&
  hasStrings(value, [
    "id",
    "organization_id",
    "repository_id",
    "title",
    "objective",
    "acceptance_contract_id",
    "state",
  ]);

export const isMissionList: ResponseValidator<Mission[]> = (value): value is Mission[] =>
  Array.isArray(value) && value.every(isMission);

const isWorkPackage: ResponseValidator<WorkPackage> = (value): value is WorkPackage =>
  isRecord(value) &&
  hasStrings(value, ["id", "mission_id", "plan_revision_id", "task_class", "title", "state"]);

export const isMissionView: ResponseValidator<MissionView> = (value): value is MissionView =>
  isRecord(value) &&
  isMission(value.mission) &&
  Array.isArray(value.packages) &&
  value.packages.every(isWorkPackage) &&
  (value.fence === null || isInteger(value.fence));

export const isDemoReceipt: ResponseValidator<DemoReceipt> = (
  value,
): value is DemoReceipt =>
  isRecord(value) &&
  hasStrings(value, [
    "mission_id",
    "plan_hash",
    "attempt_id",
    "attempt_second_id",
    "stale_attempt_id",
    "candidate_head",
    "evidence_result",
    "effect_outcome",
    "effect_unknown_outcome",
  ]) &&
  isInteger(value.fence_first) &&
  isInteger(value.fence_second) &&
  typeof value.materialize_idempotent === "boolean" &&
  typeof value.stale_refused === "boolean";

const isOutboxItem: ResponseValidator<OutboxItem> = (value): value is OutboxItem =>
  isRecord(value) &&
  isInteger(value.seq) &&
  hasStrings(value, ["kind", "payload", "phase"]) &&
  isNullableString(value.delivered_at) &&
  isNullableString(value.acked_at);

export const isOutboxView: ResponseValidator<OutboxView> = (value): value is OutboxView =>
  isRecord(value) && Array.isArray(value.items) && value.items.every(isOutboxItem);

export const isReadyView: ResponseValidator<ReadyView> = (value): value is ReadyView =>
  isRecord(value) &&
  hasStrings(value, ["work_package_id", "mission_id", "variant_id", "title", "enqueued_at"]);

export const isNullableReadyView: ResponseValidator<ReadyView | null> = (
  value,
): value is ReadyView | null => value === null || isReadyView(value);

const COMMAND_ID = /^cmd_[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CSRF_TOKEN = /^csrf_[0-9a-f]{64}$/;
const COMMAND_STATUSES = new Set(["PENDING", "APPLIED", "VERIFIED", "FAILED", "UNKNOWN"]);

export const isBootstrapResponse: ResponseValidator<BootstrapResponse> = (
  value,
): value is BootstrapResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["csrf_token", "expires_in_seconds", "status"]) &&
  value.status === "AUTHENTICATED" &&
  typeof value.csrf_token === "string" &&
  CSRF_TOKEN.test(value.csrf_token) &&
  isInteger(value.expires_in_seconds) &&
  value.expires_in_seconds > 0;

export const isCommandStatus: ResponseValidator<CommandStatus> = (
  value,
): value is CommandStatus =>
  isRecord(value) &&
  hasExactKeys(value, ["id", "kind", "payload_digest", "result", "status"]) &&
  typeof value.id === "string" &&
  COMMAND_ID.test(value.id) &&
  typeof value.status === "string" &&
  COMMAND_STATUSES.has(value.status) &&
  typeof value.kind === "string" &&
  value.kind.length > 0 &&
  typeof value.payload_digest === "string" &&
  DIGEST.test(value.payload_digest) &&
  value.result !== undefined &&
  (value.status === "PENDING" ? value.result === null : true) &&
  (["APPLIED", "VERIFIED", "FAILED"].includes(value.status) ? value.result !== null : true);

export const isProblem: ResponseValidator<Problem> = (value): value is Problem =>
  isRecord(value) &&
  hasExactKeys(value, [
    "code",
    "correlation_id",
    "detail",
    "instance",
    "repair",
    "request_id",
    "retryable",
    "status",
    "title",
    "type",
  ]) &&
  hasStrings(value, [
    "code",
    "correlation_id",
    "detail",
    "instance",
    "repair",
    "request_id",
    "title",
    "type",
  ]) &&
  isInteger(value.status) &&
  value.status >= 400 &&
  value.status <= 599 &&
  typeof value.retryable === "boolean";
