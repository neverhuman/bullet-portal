import Ajv2020 from "ajv/dist/2020.js";
import { PUBLIC_API_RUNTIME_REFS, PUBLIC_API_RUNTIME_SCHEMA } from "./generated/api";
import type {
  AuditView,
  BootstrapResponse,
  CommandStatus,
  DemoReceipt,
  FleetView,
  Health,
  MergeRailView,
  Mission,
  MissionView,
  OutboxItem,
  OutboxView,
  Problem,
  QualityLabView,
  ReadyView,
  SessionSupervisorView,
} from "./generated/api";

export type ResponseValidator<T> = (value: unknown) => value is T;

const schemaCompiler = new Ajv2020({ allErrors: false, strict: true });
schemaCompiler.addSchema(PUBLIC_API_RUNTIME_SCHEMA);

function compileGeneratedValidator<T>(reference: string): ResponseValidator<T> {
  const validate = schemaCompiler.getSchema<T>(reference);
  if (validate === undefined) {
    throw new Error(`generated API schema is missing ${reference}`);
  }
  return (value): value is T => validate(value) === true;
}

const validatesCommandStatus = compileGeneratedValidator<CommandStatus>(
  PUBLIC_API_RUNTIME_REFS.CommandStatus,
);
const validatesMission = compileGeneratedValidator<Mission>(PUBLIC_API_RUNTIME_REFS.Mission);
const validatesMissionView = compileGeneratedValidator<MissionView>(
  PUBLIC_API_RUNTIME_REFS.MissionView,
);
const validatesReadyView = compileGeneratedValidator<ReadyView>(
  PUBLIC_API_RUNTIME_REFS.ReadyView,
);

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

export const isMission: ResponseValidator<Mission> = validatesMission;

export const isMissionList: ResponseValidator<Mission[]> = (value): value is Mission[] =>
  Array.isArray(value) && value.every(isMission);

export const isMissionView: ResponseValidator<MissionView> = (value): value is MissionView =>
  validatesMissionView(value) &&
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

export const isReadyView: ResponseValidator<ReadyView> = validatesReadyView;

export const isNullableReadyView: ResponseValidator<ReadyView | null> = (
  value,
): value is ReadyView | null => value === null || isReadyView(value);

const CSRF_TOKEN = /^csrf_[0-9a-f]{64}$/;

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
  validatesCommandStatus(value) &&
  value.kind.length > 0 &&
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

const validatesFleetView = compileGeneratedValidator<FleetView>(PUBLIC_API_RUNTIME_REFS.FleetView);
const validatesSessionSupervisorView = compileGeneratedValidator<SessionSupervisorView>(
  PUBLIC_API_RUNTIME_REFS.SessionSupervisorView,
);
const validatesMergeRailView = compileGeneratedValidator<MergeRailView>(
  PUBLIC_API_RUNTIME_REFS.MergeRailView,
);
const validatesQualityLabView = compileGeneratedValidator<QualityLabView>(
  PUBLIC_API_RUNTIME_REFS.QualityLabView,
);
const validatesAuditView = compileGeneratedValidator<AuditView>(PUBLIC_API_RUNTIME_REFS.AuditView);

export const isFleetView: ResponseValidator<FleetView> = validatesFleetView;

export const isSessionSupervisorView: ResponseValidator<SessionSupervisorView> =
  validatesSessionSupervisorView;

export const isMergeRailView: ResponseValidator<MergeRailView> = validatesMergeRailView;

export const isQualityLabView: ResponseValidator<QualityLabView> = validatesQualityLabView;

/**
 * The audit tail must end exactly at its watermark and be contiguous; a
 * tail that contradicts its own latest_sequence is not a projection.
 */
export function auditTailIsCoherent(view: AuditView): boolean {
  if (view.events.length > view.tail_window) {
    return false;
  }
  const last = view.events[view.events.length - 1];
  if (last === undefined) {
    return view.latest_sequence === 0;
  }
  if (last.seq !== view.latest_sequence) {
    return false;
  }
  return view.events.every(
    (event, index) => index === 0 || event.seq === (view.events[index - 1]?.seq ?? -1) + 1,
  );
}

export const isAuditView: ResponseValidator<AuditView> = (value): value is AuditView =>
  validatesAuditView(value) && auditTailIsCoherent(value);
