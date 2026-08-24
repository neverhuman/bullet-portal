import type { DemoReceipt, Health, Mission, OutboxView } from "./generated/api";

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

  constructor(method: string, url: string, status: number | null, detail: string) {
    super(`${method} ${url} failed: ${detail}`);
    this.name = "ApiError";
    this.method = method;
    this.url = url;
    this.status = status;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson<T>(path: string, init?: RequestInit): Promise<SnapshotRead<T>> {
  const method = init?.method ?? "GET";
  const url = `${apiBase}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const detail = controller.signal.aborted
      ? `timeout after ${REQUEST_TIMEOUT_MS}ms`
      : errorText(err);
    throw new ApiError(method, url, null, detail);
  } finally {
    clearTimeout(timer);
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
    );
  }
  try {
    const data = (await response.json()) as T;
    return { data, asOfSequence: readSnapshotSequence(response.headers) };
  } catch {
    throw new ApiError(method, url, response.status, "invalid JSON body");
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
  return readJson("/v1/missions");
}

export async function runDemo(): Promise<DemoReceipt> {
  return (await readJson<DemoReceipt>("/v1/demo/run", { method: "POST" })).data;
}

export function fetchOutbox(): Promise<SnapshotRead<OutboxView>> {
  return readJson("/v1/outbox");
}

export async function fetchHealth(): Promise<Health> {
  return (await readJson<Health>("/health")).data;
}
