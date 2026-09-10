import type {
  AuditView,
  BootstrapResponse,
  CommandEnvelope,
  CommandStatus,
  ContextLineageView,
  FleetView,
  Health,
  MergeRailView,
  Mission,
  MissionView,
  OperatorSnapshotView,
  OutboxView,
  QualityLabView,
  ReadyView,
  SessionSupervisorView,
} from "./generated/api";
import { API_PREFIX } from "./generated/api";
import {
  isAuditView,
  isBootstrapResponse,
  isCommandStatus,
  isContextLineageView,
  isFleetView,
  isHealth,
  isMergeRailView,
  isMissionList,
  isMissionView,
  isNullableReadyView,
  isOperatorSnapshotView,
  isOutboxView,
  isQualityLabView,
  isSessionSupervisorView,
} from "./apiValidation";
import { CSRF_HEADER, csrfToken, rememberCsrfToken } from "./apiSession";
import { ApiError, apiBase, readJson, readSnapshot, type SnapshotRead } from "./apiTransport";

export { apiBase, ApiError, errorText, type SnapshotRead } from "./apiTransport";
export { forgetBrowserSession, hasSessionMaterial } from "./apiSession";

export function listMissions(): Promise<SnapshotRead<Mission[]>> {
  return readSnapshot(`${API_PREFIX}/missions`, isMissionList);
}

export async function exchangeBootstrap(bootstrapToken: string): Promise<BootstrapResponse> {
  const response = await readJson(
    `${API_PREFIX}/auth/bootstrap`,
    isBootstrapResponse,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrap_token: bootstrapToken }),
    },
    200,
  );
  rememberCsrfToken(response.csrf_token);
  return response;
}

export function newRunDemoEnvelope(): CommandEnvelope {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    idempotency_key: `portal_${nonce}`,
    kind: "run_demo",
    payload: {},
  };
}

export type CodingProviderName = "claude" | "codex" | "cursor" | "antigravity";

export type RunCodingFields = {
  accountId: string;
  provider: CodingProviderName;
  model: string;
  expectedRevision?: number;
};

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newRunCodingEnvelope(fields: RunCodingFields): CommandEnvelope {
  if (fields.accountId.trim() === "" || fields.model.trim() === "") {
    throw new Error("run_coding requires an explicit account id and model");
  }
  return {
    idempotency_key: `portal_${randomHex(16)}`,
    kind: "run_coding",
    payload: {
      account_id: fields.accountId.trim(),
      provider: fields.provider,
      model: fields.model.trim(),
      expected_revision: fields.expectedRevision ?? 1,
      launch_nonce: randomHex(32),
      quota_reservation: `rsv_${randomHex(32)}`,
      quota_units: 1,
      allocated_run: `run_${randomHex(32)}`,
    },
  };
}

export async function submitCommand(envelope: CommandEnvelope): Promise<CommandStatus> {
  const csrf = csrfToken();
  if (csrf === null) {
    throw new ApiError(
      "POST",
      `${apiBase}${API_PREFIX}/commands`,
      null,
      "no authenticated browser session; exchange the one-time bootstrap first",
      false,
    );
  }
  const status = await readJson(
    `${API_PREFIX}/commands`,
    isCommandStatus,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: csrf,
      },
      body: JSON.stringify(envelope),
    },
    202,
  );
  if (status.status !== "PENDING" || status.kind !== envelope.kind || status.result !== null) {
    throw new ApiError(
      "POST",
      `${apiBase}${API_PREFIX}/commands`,
      202,
      "admission response was not the exact PENDING command subject",
      true,
    );
  }
  return status;
}

export async function getCommand(id: string): Promise<CommandStatus> {
  const status = await readJson(`${API_PREFIX}/commands/${encodeURIComponent(id)}`, isCommandStatus);
  if (status.id !== id) {
    throw new ApiError(
      "GET",
      `${apiBase}${API_PREFIX}/commands/${encodeURIComponent(id)}`,
      200,
      "command response id does not match the requested subject",
    );
  }
  return status;
}

export function fetchOutbox(): Promise<SnapshotRead<OutboxView>> {
  return readSnapshot(`${API_PREFIX}/outbox`, isOutboxView);
}

export async function fetchHealth(): Promise<Health> {
  return readJson("/health", isHealth);
}

export function getMission(id: string): Promise<SnapshotRead<MissionView>> {
  return readSnapshot(`${API_PREFIX}/missions/${id}`, isMissionView);
}

export function fetchReady(): Promise<SnapshotRead<ReadyView | null>> {
  return readSnapshot(`${API_PREFIX}/ready`, isNullableReadyView);
}

export function fetchFleet(): Promise<SnapshotRead<FleetView>> {
  return readSnapshot(`${API_PREFIX}/fleet`, isFleetView);
}

export function fetchSessions(): Promise<SnapshotRead<SessionSupervisorView>> {
  return readSnapshot(`${API_PREFIX}/sessions`, isSessionSupervisorView);
}

export function fetchContextLineage(): Promise<SnapshotRead<ContextLineageView>> {
  return readSnapshot(`${API_PREFIX}/context-lineage`, isContextLineageView);
}

export function fetchMergeRail(): Promise<SnapshotRead<MergeRailView>> {
  return readSnapshot(`${API_PREFIX}/merge-rail`, isMergeRailView);
}

export function fetchQualityLab(): Promise<SnapshotRead<QualityLabView>> {
  return readSnapshot(`${API_PREFIX}/quality-lab`, isQualityLabView);
}

export function fetchAudit(): Promise<SnapshotRead<AuditView>> {
  return readSnapshot(`${API_PREFIX}/audit`, isAuditView);
}

/** All composed operator subjects come from one server transaction. */
export async function fetchOperatorSnapshot(): Promise<SnapshotRead<OperatorSnapshotView>> {
  const path = `${API_PREFIX}/operator-snapshot`;
  const snapshot = await readSnapshot(path, isOperatorSnapshotView);
  if (snapshot.data.audit.latest_sequence !== snapshot.asOfSequence) {
    throw new ApiError("GET", path, 200, "snapshot audit watermark mismatch");
  }
  return snapshot;
}
