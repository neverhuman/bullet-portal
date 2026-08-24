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
  isOutboxView,
  isReadyView,
  type ResponseValidator,
} from "./apiValidation";

export const apiBase: string = import.meta.env.VITE_BULLET_API ?? "";

const REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_SEQUENCE_HEADER = "x-bullet-as-of-sequence";

export type SnapshotRead<T> = {
  data: T;
  asOfSequence: number | null;
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

async function readJson<T>(
  path: string,
  validate: ResponseValidator<T>,
  init?: RequestInit,
): Promise<SnapshotRead<T>> {
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
    if (!contentType.includes("application/json")) {
      throw new ApiError(
        method,
        url,
        response.status,
        `unexpected content-type ${contentType === "" ? "(none)" : contentType}`,
        method !== "GET" && method !== "HEAD",
      );
    }
    let data: unknown;
    try {
      data = await response.json();
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
    if (!validate(data)) {
      throw new ApiError(
        method,
        url,
        response.status,
        "response body failed schema validation",
        method !== "GET" && method !== "HEAD",
      );
    }
    return { data, asOfSequence: readSnapshotSequence(response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

function readSnapshotSequence(headers: Headers): number | null {
  const raw = headers.get(SNAPSHOT_SEQUENCE_HEADER);
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function listMissions(): Promise<SnapshotRead<Mission[]>> {
  return readJson("/v1/missions", isMissionList);
}

export async function runDemo(): Promise<DemoReceipt> {
  return (await readJson("/v1/demo/run", isDemoReceipt, { method: "POST" })).data;
}

export function fetchOutbox(): Promise<SnapshotRead<OutboxView>> {
  return readJson("/v1/outbox", isOutboxView);
}

export async function fetchHealth(): Promise<Health> {
  return (await readJson("/health", isHealth)).data;
}

export function getMission(id: string): Promise<SnapshotRead<MissionView>> {
  return readJson(`/v1/missions/${id}`, isMissionView);
}

export async function fetchReady(): Promise<SnapshotRead<ReadyView | null>> {
  try {
    return await readJson("/v1/ready", isReadyView);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { data: null, asOfSequence: null };
    }
    throw err;
  }
}
