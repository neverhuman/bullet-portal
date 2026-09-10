import { isProblem, isSnapshotEnvelope, SNAPSHOT_SOURCE, type ResponseValidator } from "./apiValidation";
import type { Problem } from "./generated/api";
import { assertOwner, discoverOwner, forgetRefusedOwner, ownerHeaders } from "./apiOwner";
import { browserSessionEpoch, onBrowserSessionChange } from "./apiSession";

export const apiBase = "";

const REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_SEQUENCE_HEADER = "x-bullet-as-of-sequence";

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
  readonly acknowledgedSession: string | null;

  constructor(
    method: string,
    url: string,
    status: number | null,
    detail: string,
    outcomeUnknown = method !== "GET" && method !== "HEAD" && status === null,
    problem?: Problem,
    acknowledgedSession: string | null = null,
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
    this.acknowledgedSession = acknowledgedSession;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasMediaType(contentType: string, expected: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

type JsonRead = {
  body: unknown;
  headers: Headers;
  method: string;
  status: number;
  url: string;
};

export async function fetchJson(
  path: string,
  init?: RequestInit,
  expectedStatus?: number,
): Promise<JsonRead> {
  const method = init?.method ?? "GET";
  const url = `${apiBase}${path}`;
  const external = init?.signal;
  if (external?.aborted) {
    throw new ApiError(method, url, null, "request canceled before dispatch", false);
  }
  const controller = new AbortController();
  const epoch = browserSessionEpoch();
  const unsubscribe = onBrowserSessionChange(() => controller.abort());
  const cancel = (): void => controller.abort();
  external?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const cancellation = (): string => browserSessionEpoch() !== epoch ? "SESSION_CHANGED: authentication changed during request" : external?.aborted
    ? "request canceled"
    : `timeout after ${REQUEST_TIMEOUT_MS}ms`;
  const checkCanceled = (): void => {
    if (controller.signal.aborted) throw new ApiError(method, url, null, cancellation());
  };
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
        ? cancellation()
        : errorText(err);
      throw new ApiError(method, url, null, detail);
    }
    checkCanceled();
    const expectedSession = new Headers(init?.headers).get("x-bullet-expected-session");
    const acknowledgedSession = expectedSession !== null &&
      response.headers.get("x-bullet-session-id") === expectedSession ? expectedSession : null;
    // Authentication refusals may originate before the session guard. Every other
    // result, including absence, must bind the selected session before body access.
    if (expectedSession !== null && acknowledgedSession === null &&
        response.status !== 401 && response.status !== 403) {
      throw new ApiError(method, url, response.status,
        "SESSION_BINDING_REQUIRED: server did not confirm the requested session",
        method !== "GET" && method !== "HEAD");
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
      checkCanceled();
      if (isProblem(problem) && problem.status === response.status) {
        throw new ApiError(
          method,
          url,
          response.status,
          `${problem.code}: ${problem.detail} Repair: ${problem.repair} (${problem.request_id})`,
          false,
          problem,
          acknowledgedSession,
        );
      }
      throw new ApiError(method, url, response.status, `HTTP ${response.status}`, false,
        undefined, acknowledgedSession);
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
          ? cancellation()
          : "invalid JSON body",
        method !== "GET" && method !== "HEAD",
      );
    }
    checkCanceled();
    return { body, headers: response.headers, method, status: response.status, url };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", cancel);
    unsubscribe();
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

export async function readJson<T>(
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

export async function readSnapshot<T>(
  path: string,
  validateData: ResponseValidator<T>,
  signal?: AbortSignal,
  headers?: HeadersInit,
): Promise<SnapshotRead<T>> {
  const owner = headers === undefined ? await discoverOwner(signal) : null;
  let read: JsonRead;
  try {
    read = await fetchJson(path, { signal, headers: headers ?? ownerHeaders(owner!) }, 200);
    if (owner !== null) assertOwner(owner, signal);
  } catch (error) {
    if (owner !== null) forgetRefusedOwner(owner, error);
    throw error;
  }
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
