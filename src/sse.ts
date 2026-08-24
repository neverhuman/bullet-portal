export type SseFrame = {
  id: string | null;
  event: string;
  data: string;
};

export type SseCallbacks = {
  onOpen: () => void;
  onFrame: (frame: SseFrame) => void;
};

const MAX_SSE_FRAME_CHARS = 1024 * 1024;

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
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match === null ? null : { index: match.index, length: match[0].length };
}

export function createSseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let boundary = findBoundary(buffer);
    while (boundary !== null) {
      if (boundary.index > MAX_SSE_FRAME_CHARS) {
        throw new Error("SSE frame exceeds 1 MiB character limit");
      }
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const frame = parseBlock(block);
      if (frame !== null) {
        onFrame(frame);
      }
      boundary = findBoundary(buffer);
    }
    if (buffer.length > MAX_SSE_FRAME_CHARS) {
      throw new Error("SSE frame exceeds 1 MiB character limit");
    }
  };
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
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (lastEventId !== undefined) {
    headers["Last-Event-ID"] = String(lastEventId);
  }
  const response = await fetch(url, {
    signal,
    headers,
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(
      `GET ${url} failed: unexpected content-type ${contentType === "" ? "(none)" : contentType}`,
    );
  }
  if (response.body === null) {
    throw new Error(`GET ${url} failed: response body missing`);
  }
  cb.onOpen();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser(cb.onFrame);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      parse(decoder.decode());
      return;
    }
    parse(decoder.decode(value, { stream: true }));
  }
}
