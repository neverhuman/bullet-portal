import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEventStream } from "./hooks/useEventStream";
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
      "SSE frame exceeds 1 MiB UTF-8 byte limit",
    );
  });

  it("counts multibyte frame content in UTF-8 bytes, not JavaScript characters", () => {
    const frames: SseFrame[] = [];
    const splitFeed = createSseParser((frame) => frames.push(frame));
    splitFeed("data: \ud83d");
    splitFeed("\ude00\n\n");
    expect(frames).toEqual([{ id: null, event: "message", data: "😀" }]);

    const overflowFeed = createSseParser(() => {});
    const oversized = `data: ${"€".repeat(350_000)}`;
    expect(oversized.length).toBeLessThan(1024 * 1024);
    expect(() => overflowFeed(oversized)).toThrow(
      "SSE frame exceeds 1 MiB UTF-8 byte limit",
    );
  });

  it("parses independently mixed line endings split after a trailing CR", () => {
    const frames: SseFrame[] = [];
    const feed = createSseParser((frame) => frames.push(frame));
    feed("id: 1\r\ndata: one\n\r");
    feed("\nid: 2\rdata: two\r\n\r");
    feed("\n");
    expect(frames).toEqual([
      { id: "1", event: "message", data: "one" },
      { id: "2", event: "message", data: "two" },
    ]);
  });
});

describe("SSE resume transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts when response headers remain inactive and clears its deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );
    const outcome = readSseStream(
      "/api/v1/events",
      new AbortController().signal,
      { onOpen: () => {}, onFrame: () => {} },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      message: "GET /api/v1/events failed: response headers inactive for 10000ms",
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a pre-aborted caller without invoking fetch or leaking its rejection", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("fetch-after-preabort")));
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    caller.abort(new Error("caller stopped"));

    await expect(
      readSseStream(
        "/api/v1/events",
        caller.signal,
        { onOpen: () => {}, onFrame: () => {} },
      ),
    ).rejects.toThrow("caller stopped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts and cancels a response whose body remains inactive", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    );
    const onOpen = vi.fn();
    const outcome = readSseStream(
      "/api/v1/events",
      new AbortController().signal,
      { onOpen, onFrame: () => {} },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(onOpen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(outcome).resolves.toMatchObject({
      message: "GET /api/v1/events failed: response body inactive for 30000ms",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending body read and clears its deadline on caller abort", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    );
    const caller = new AbortController();
    const outcome = readSseStream(
      "/api/v1/events",
      caller.signal,
      { onOpen: () => {}, onFrame: () => {} },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);

    caller.abort(new Error("caller stopped"));

    await expect(outcome).resolves.toMatchObject({ message: "caller stopped" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a zero-length body chunk without starving the inactivity timer", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => controller.enqueue(new Uint8Array()),
              cancel,
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    );
    const outcome = readSseStream(
      "/api/v1/events",
      new AbortController().signal,
      { onOpen: () => {}, onFrame: () => {} },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toMatchObject({
      message: "GET /api/v1/events failed: zero-length response body chunk",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats keep-alive comments as body liveness without emitting a frame", async () => {
    vi.useFakeTimers();
    const frames: SseFrame[] = [];
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                body = controller;
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    );
    const reading = readSseStream(
      "/api/v1/events",
      new AbortController().signal,
      { onOpen: () => {}, onFrame: (frame) => frames.push(frame) },
    );
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(29_999);
    body.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([]);

    await vi.advanceTimersByTimeAsync(29_999);
    body.enqueue(new TextEncoder().encode("id: 3\ndata: payload\n\n"));
    await vi.advanceTimersByTimeAsync(0);
    body.close();
    await reading;

    expect(frames).toEqual([{ id: "3", event: "message", data: "payload" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires snapshot coverage through a malformed safe numeric cursor", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode("id: 4\ndata: not-json\n\n"));
              },
              cancel,
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    );
    const onGap = vi.fn((required: number) =>
      Promise.resolve(required === 0 ? 2 : required === 4 ? 3 : null),
    );
    const { result, unmount } = renderHook(() => useEventStream(onGap));

    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(onGap.mock.calls).toEqual([[0], [4]]);
    expect(result.current).toMatchObject({
      connection: "live",
      asOfSequence: 2,
      stale: true,
    });

    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rebases an open stream after snapshot recovery before acknowledging more events", async () => {
    vi.useFakeTimers();
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode("id: 3\ndata: not-json\n\n"));
              },
              cancel: firstCancel,
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ cancel: secondCancel }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onGap = vi.fn((required: number) =>
      Promise.resolve(required === 0 ? 2 : required === 3 ? 4 : null),
    );
    const { result, unmount } = renderHook(() => useEventStream(onGap));

    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(onGap.mock.calls).toEqual([[0], [3]]);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/events");
    expect(init.headers).toEqual({
      accept: "text/event-stream",
      "Last-Event-ID": "4",
    });
    expect(result.current).toMatchObject({
      connection: "live",
      asOfSequence: 4,
      stale: false,
    });

    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks an opened hung stream STALE and stops retry timers on cleanup", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );
    const { result, unmount } = renderHook(() => useEventStream(() => Promise.resolve(0)));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.connection).toBe("live");
    expect(result.current.stale).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(30_000));

    expect(result.current).toMatchObject({
      connection: "reconnecting",
      detail: "connection lost, retrying",
      stale: true,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [retryUrl, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(retryUrl).toBe("/api/v1/events");
    expect(retryInit.headers).toEqual({
      accept: "text/event-stream",
      "Last-Event-ID": "0",
    });
    expect(result.current).toMatchObject({ connection: "live", stale: true });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
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
