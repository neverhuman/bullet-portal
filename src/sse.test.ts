import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseParser, readSseStream, type SseFrame } from "./sse";

describe("SSE framing", () => {
  it("parses CRLF boundaries split across chunks", () => {
    const frames: SseFrame[] = [];
    const feed = createSseParser((frame) => frames.push(frame));
    feed("id: 1\r\ndata: one\r\n\r");
    feed("\nid: 2\rdata: two\r\r");
    expect(frames).toEqual([
      { id: "1", event: "message", data: "one" },
      { id: "2", event: "message", data: "two" },
    ]);
  });

  it("refuses an unbounded partial frame", () => {
    const feed = createSseParser(() => {});
    expect(() => feed(`data: ${"x".repeat(1024 * 1024)}`)).toThrow(
      "SSE frame exceeds 1 MiB character limit",
    );
  });
});

describe("SSE resume transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the exact acknowledged sequence as Last-Event-ID on reconnect", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await readSseStream(
      "/api/v1/events",
      new AbortController().signal,
      { onOpen: () => {}, onFrame: () => {} },
      2,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/events");
    expect(init.headers).toEqual({ accept: "text/event-stream", "Last-Event-ID": "2" });
  });

  it("refuses an invalid resume cursor before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      readSseStream(
        "/api/v1/events",
        new AbortController().signal,
        { onOpen: () => {}, onFrame: () => {} },
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ).rejects.toThrow("Last-Event-ID must be a non-negative safe integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a deceptive HTTP 200 media type before declaring the stream live", async () => {
    const onOpen = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("data: payload\n\n", {
            status: 200,
            headers: { "content-type": "application/text/event-stream-shadow" },
          }),
        ),
      ),
    );
    await expect(
      readSseStream(
        "/api/v1/events?after=2",
        new AbortController().signal,
        { onOpen, onFrame: () => {} },
      ),
    ).rejects.toThrow(
      "GET /api/v1/events?after=2 failed: unexpected content-type application/text/event-stream-shadow",
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("accepts the exact event-stream media type with case-insensitive parameters", async () => {
    const frames: SseFrame[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("id: 3\ndata: payload\n\n", {
            status: 200,
            headers: { "content-type": "Text/Event-Stream; Charset=UTF-8" },
          }),
        ),
      ),
    );
    await readSseStream(
      "/api/v1/events?after=2",
      new AbortController().signal,
      { onOpen: () => {}, onFrame: (frame) => frames.push(frame) },
    );
    expect(frames).toEqual([{ id: "3", event: "message", data: "payload" }]);
  });
});
