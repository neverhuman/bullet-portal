import type {
  DemoReceipt,
  Health,
  Mission,
  MissionView,
  OutboxView,
  ReadyView,
} from "./generated/api";
import {
  isDemoReceipt,
  isHealth,
  isMissionList,
  isMissionView,
  isNullableReadyView,
  isOutboxView,
  isSnapshotEnvelope,
  SNAPSHOT_SOURCE,
  type ResponseValidator,
} from "./apiValidation";

export const apiBase: string = import.meta.env.VITE_BULLET_API ?? "";

const REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_SEQUENCE_HEADER = "x-bullet-as-of-sequence";

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

  constructor(
    method: string,
    url: string,
    status: number | null,
    detail: string,
    outcomeUnknown = method !== "GET" && method !== "HEAD" && status === null,
  ) {
    super(`${method} ${url} failed: ${detail}`);
    this.name = "ApiError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
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

async function fetchJson(path: string, init?: RequestInit): Promise<JsonRead> {
  const method = init?.method ?? "GET";
  const url = `${apiBase}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timeout after ${REQUEST_TIMEOUT_MS}ms`
        : errorText(err);
      throw new ApiError(method, url, null, detail);
    }
    if (!response.ok) {
      throw new ApiError(method, url, response.status, `HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
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
): Promise<T> {
  const read = await fetchJson(path, init);
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
  return readSnapshot("/v1/missions", isMissionList);
}

export async function runDemo(): Promise<DemoReceipt> {
  return readJson("/v1/demo/run", isDemoReceipt, { method: "POST" });
}

export function fetchOutbox(): Promise<SnapshotRead<OutboxView>> {
  return readSnapshot("/v1/outbox", isOutboxView);
}

export async function fetchHealth(): Promise<Health> {
  return readJson("/health", isHealth);
}

export function getMission(id: string): Promise<SnapshotRead<MissionView>> {
  return readSnapshot(`/v1/missions/${id}`, isMissionView);
}

export function fetchReady(): Promise<SnapshotRead<ReadyView | null>> {
  return readSnapshot("/v1/ready", isNullableReadyView);
}
