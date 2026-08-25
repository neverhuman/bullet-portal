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
  OutboxView,
  Problem,
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
  isOutboxView,
  isProblem,
  isQualityLabView,
  isSessionSupervisorView,
  isSnapshotEnvelope,
  SNAPSHOT_SOURCE,
  type ResponseValidator,
} from "./apiValidation";

export const apiBase = "";

const REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_SEQUENCE_HEADER = "x-bullet-as-of-sequence";
const CSRF_HEADER = "x-bullet-csrf";
const CSRF_STORAGE_SLOT = "bullet-farm.csrf.v1";

let csrfInMemory: string | null = null;

function hasMediaType(contentType: string, expected: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

export type SnapshotRead<T> = {
  data: T;
  asOfSequence: number;
  observedAt: string;
  source: typeof SNAPSHOT_SOURCE;
};

export class ApiError extends Error {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly outcomeUnknown: boolean;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly repair: string | null;

  constructor(
    method: string,
    url: string,
    status: number | null,
    detail: string,
    outcomeUnknown = method !== "GET" && method !== "HEAD" && status === null,
    problem?: Problem,
  ) {
    super(`${method} ${url} failed: ${detail}`);
    this.name = "ApiError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.code = problem?.code ?? null;
    this.requestId = problem?.request_id ?? null;
    this.repair = problem?.repair ?? null;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type JsonRead = {
  body: unknown;
  headers: Headers;
  method: string;
  status: number;
  url: string;
};

async function fetchJson(
  path: string,
  init?: RequestInit,
  expectedStatus?: number,
): Promise<JsonRead> {
  const method = init?.method ?? "GET";
  const url = `${apiBase}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timeout after ${REQUEST_TIMEOUT_MS}ms`
        : errorText(err);
      throw new ApiError(method, url, null, detail);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      let problem: unknown;
      if (hasMediaType(contentType, "application/problem+json")) {
        try {
          problem = await response.json();
        } catch {
          problem = undefined;
        }
      }
      if (isProblem(problem) && problem.status === response.status) {
        throw new ApiError(
          method,
          url,
          response.status,
          `${problem.code}: ${problem.detail} Repair: ${problem.repair} (${problem.request_id})`,
          false,
          problem,
        );
      }
      throw new ApiError(method, url, response.status, `HTTP ${response.status}`);
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new ApiError(
        method,
        url,
        response.status,
        `expected HTTP ${expectedStatus}, received HTTP ${response.status}`,
        method !== "GET" && method !== "HEAD",
      );
    }
    if (!hasMediaType(contentType, "application/json")) {
      throw new ApiError(
        method,
        url,
        response.status,
        `unexpected content-type ${contentType === "" ? "(none)" : contentType}`,
        method !== "GET" && method !== "HEAD",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        method,
        url,
        controller.signal.aborted ? null : response.status,
        controller.signal.aborted
          ? `timeout after ${REQUEST_TIMEOUT_MS}ms`
          : "invalid JSON body",
        method !== "GET" && method !== "HEAD",
      );
    }
    return { body, headers: response.headers, method, status: response.status, url };
  } finally {
    clearTimeout(timer);
  }
}

function schemaError(read: JsonRead, detail: string): ApiError {
  return new ApiError(
    read.method,
    read.url,
    read.status,
    detail,
    read.method !== "GET" && read.method !== "HEAD",
  );
}

async function readJson<T>(
  path: string,
  validate: ResponseValidator<T>,
  init?: RequestInit,
  expectedStatus?: number,
): Promise<T> {
  const read = await fetchJson(path, init, expectedStatus);
  if (!validate(read.body)) {
    throw schemaError(read, "response body failed schema validation");
  }
  return read.body;
}

async function readSnapshot<T>(
  path: string,
  validateData: ResponseValidator<T>,
): Promise<SnapshotRead<T>> {
  const read = await fetchJson(path);
  if (!isSnapshotEnvelope(read.body, validateData)) {
    throw schemaError(read, "snapshot body failed schema validation");
  }
  const headerSequence = readSnapshotSequence(read.headers, read);
  if (headerSequence !== read.body.as_of_sequence) {
    throw schemaError(read, "snapshot watermark header/body mismatch");
  }
  return {
    data: read.body.data,
    asOfSequence: read.body.as_of_sequence,
    observedAt: read.body.observed_at,
    source: read.body.source,
  };
}

function readSnapshotSequence(headers: Headers, read: JsonRead): number {
  const raw = headers.get(SNAPSHOT_SEQUENCE_HEADER);
  if (raw === null) {
    throw schemaError(read, "snapshot watermark header is missing");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw schemaError(read, "snapshot watermark header is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw schemaError(read, "snapshot watermark header is invalid");
  }
  return value;
}

export function listMissions(): Promise<SnapshotRead<Mission[]>> {
  return readSnapshot(`${API_PREFIX}/missions`, isMissionList);
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function storedCsrfToken(): string | null {
  try {
    return browserStorage()?.getItem(CSRF_STORAGE_SLOT) ?? null;
  } catch {
    return null;
  }
}

function csrfToken(): string | null {
  return csrfInMemory ?? storedCsrfToken();
}

export function hasSessionMaterial(): boolean {
  return csrfToken() !== null;
}

export function forgetBrowserSession(): void {
  csrfInMemory = null;
  try {
    browserStorage()?.removeItem(CSRF_STORAGE_SLOT);
  } catch {
    // In-memory authority is already cleared; unavailable storage fails closed.
  }
}

function persistCsrfToken(csrf: string): void {
  try {
    browserStorage()?.setItem(CSRF_STORAGE_SLOT, csrf);
  } catch {
    // The current page can still use the in-memory token; reload will fail closed.
  }
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
  csrfInMemory = response.csrf_token;
  persistCsrfToken(response.csrf_token);
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
