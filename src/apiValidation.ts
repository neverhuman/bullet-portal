import type {
  DemoReceipt,
  Health,
  Mission,
  MissionView,
  OutboxItem,
  OutboxView,
  ReadyView,
  WorkPackage,
} from "./generated/api";

export type ResponseValidator<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
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
  isInteger(value.fence) &&
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
