import type { DemoReceipt, Health, Mission, OutboxView } from "./generated/api";

export const apiBase: string = import.meta.env.VITE_BULLET_API ?? "";

const REQUEST_TIMEOUT_MS = 10_000;

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

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
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
    return (await response.json()) as T;
  } catch {
    throw new ApiError(method, url, response.status, "invalid JSON body");
  }
}

export function listMissions(): Promise<Mission[]> {
  return readJson("/v1/missions");
}

export function runDemo(): Promise<DemoReceipt> {
  return readJson("/v1/demo/run", { method: "POST" });
}

export function fetchOutbox(): Promise<OutboxView> {
  return readJson("/v1/outbox");
}

export function fetchHealth(): Promise<Health> {
  return readJson("/health");
}
