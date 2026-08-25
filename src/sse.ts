export type SseFrame = {
  id: string | null;
  event: string;
  data: string;
};

export type SseCallbacks = {
  onOpen: () => void;
  onFrame: (frame: SseFrame) => void;
};

const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const SSE_HEADER_TIMEOUT_MS = 10_000;
const SSE_BODY_IDLE_TIMEOUT_MS = 30_000;
const UTF8 = new TextEncoder();

function utf8Length(value: string): number {
  return UTF8.encode(value).byteLength;
}

function joinsSurrogatePair(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const high = left.charCodeAt(left.length - 1);
  const low = right.charCodeAt(0);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function hasEventStreamMediaType(contentType: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function parseBlock(block: string): SseFrame | null {
  let id: string | null = null;
  let event = "message";
  const data: string[] = [];
  for (const line of block.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { id, event, data: data.join("\n") };
}

function findBoundary(buffer: string): { index: number; length: number } | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const first = endOfLineLength(buffer, index);
    if (first === 0) {
      continue;
    }
    const second = endOfLineLength(buffer, index + first);
    if (second !== 0) {
      return { index, length: first + second };
    }
    index += first - 1;
  }
  return null;
}

function endOfLineLength(buffer: string, index: number): number {
  if (buffer[index] === "\r") {
    return buffer[index + 1] === "\n" ? 2 : 1;
  }
  return buffer[index] === "\n" ? 1 : 0;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = "";
  let bufferBytes = 0;
  let discardLeadingLf = false;
  return (rawChunk) => {
    let chunk = rawChunk;
    if (discardLeadingLf) {
      discardLeadingLf = false;
      if (chunk.startsWith("\n")) {
        chunk = chunk.slice(1);
      }
    }
    const joinedPair = joinsSurrogatePair(buffer, chunk);
    buffer += chunk;
    bufferBytes += utf8Length(chunk) - (joinedPair ? 2 : 0);
    let boundary = findBoundary(buffer);
    while (boundary !== null) {
      const block = buffer.slice(0, boundary.index);
      const blockBytes = utf8Length(block);
      if (blockBytes > MAX_SSE_FRAME_BYTES) {
        throw new Error("SSE frame exceeds 1 MiB UTF-8 byte limit");
      }
      const boundaryEnd = boundary.index + boundary.length;
      const boundaryEndsWithSplitCr =
        boundaryEnd === buffer.length && buffer[boundaryEnd - 1] === "\r";
      bufferBytes -= blockBytes + utf8Length(buffer.slice(boundary.index, boundaryEnd));
      buffer = buffer.slice(boundaryEnd);
      discardLeadingLf = boundaryEndsWithSplitCr;
      const frame = parseBlock(block);
      if (frame !== null) {
        onFrame(frame);
      }
      boundary = findBoundary(buffer);
    }
    if (bufferBytes > MAX_SSE_FRAME_BYTES) {
      throw new Error("SSE frame exceeds 1 MiB UTF-8 byte limit");
    }
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function withInactivityDeadline<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      controller.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(controller.signal));
    };
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  });
}

async function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  controller: AbortController,
  url: string,
): Promise<ReadableStreamReadResult<Uint8Array<ArrayBufferLike>>> {
  const result = await withInactivityDeadline(
    reader.read(),
    controller,
    SSE_BODY_IDLE_TIMEOUT_MS,
    `GET ${url} failed: response body inactive for ${SSE_BODY_IDLE_TIMEOUT_MS}ms`,
  );
  if (!result.done && result.value.byteLength === 0) {
    throw new Error(`GET ${url} failed: zero-length response body chunk`);
  }
  return result;
}

/**
 * Read one SSE connection until the server closes it or the signal aborts.
 * A fetch-based reader keeps response validation, cancellation, and reconnect
 * policy under portal control while consuming the kernel's default messages.
 */
export async function readSseStream(
  url: string,
  signal: AbortSignal,
  cb: SseCallbacks,
  lastEventId?: number,
): Promise<void> {
  if (
    lastEventId !== undefined &&
    (!Number.isSafeInteger(lastEventId) || lastEventId < 0)
  ) {
    throw new Error("Last-Event-ID must be a non-negative safe integer");
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (lastEventId !== undefined) {
    headers["Last-Event-ID"] = String(lastEventId);
  }
  const connection = new AbortController();
  const relayAbort = (): void => connection.abort(signal.reason);
  signal.addEventListener("abort", relayAbort, { once: true });

  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | null = null;
  let reachedEof = false;
  try {
    const response = await withInactivityDeadline(
      fetch(url, { signal: connection.signal, headers }),
      connection,
      SSE_HEADER_TIMEOUT_MS,
      `GET ${url} failed: response headers inactive for ${SSE_HEADER_TIMEOUT_MS}ms`,
    );
    if (!response.ok) {
      throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!hasEventStreamMediaType(contentType)) {
      throw new Error(
        `GET ${url} failed: unexpected content-type ${contentType === "" ? "(none)" : contentType}`,
      );
    }
    if (response.body === null) {
      throw new Error(`GET ${url} failed: response body missing`);
    }
    reader = response.body.getReader();
    cb.onOpen();
    const decoder = new TextDecoder();
    const parse = createSseParser(cb.onFrame);
    for (;;) {
      const { done, value } = await readBodyChunk(reader, connection, url);
      if (done) {
        parse(decoder.decode());
        reachedEof = true;
        return;
      }
      parse(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (!connection.signal.aborted) {
      connection.abort(error);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", relayAbort);
    if (reader !== null) {
      if (!reachedEof) {
        void reader.cancel(connection.signal.reason).catch(() => {});
      }
      reader.releaseLock();
    }
  }
}
