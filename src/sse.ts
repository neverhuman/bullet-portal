export type SseFrame = {
  id: string | null;
  event: string;
  data: string;
};

export type SseCallbacks = {
  onOpen: () => void;
  onFrame: (frame: SseFrame) => void;
};

function parseBlock(block: string): SseFrame | null {
  let id: string | null = null;
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
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

export function createSseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseBlock(block);
      if (frame !== null) {
        onFrame(frame);
      }
      boundary = buffer.indexOf("\n\n");
    }
  };
}

/**
 * Read one SSE connection until the server closes it or the signal aborts.
 * A fetch-based reader is required because the kernel names every frame with
 * `event: <kind>`, which EventSource.onmessage never delivers.
 */
export async function readSseStream(
  url: string,
  signal: AbortSignal,
  cb: SseCallbacks,
): Promise<void> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "text/event-stream" },
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
      return;
    }
    parse(decoder.decode(value, { stream: true }));
  }
}
