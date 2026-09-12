import { afterEach, expect, it, vi } from "vitest";
import { readSseStream } from "./sse";

afterEach(() => { vi.unstubAllGlobals(); });

it("requires the exact selected session before opening or reading a stream", async () => {
  const expected = `sid_${"1".repeat(64)}`;
  for (const observed of [null, `sid_${"2".repeat(64)}`, expected]) {
    const headers = new Headers({ "content-type": "text/event-stream" });
    if (observed !== null) headers.set("x-bullet-session-id", observed);
    const response = new Response("id: 1\ndata: private\n\n", { headers });
    const reader = vi.spyOn(response.body!, "getReader");
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    const onOpen = vi.fn(); const onFrame = vi.fn();
    const request = readSseStream("/events", new AbortController().signal, { onOpen, onFrame }, 0, expected);
    if (observed === expected) {
      await request;
      expect(onOpen).toHaveBeenCalledOnce(); expect(onFrame).toHaveBeenCalledOnce();
    } else {
      await expect(request).rejects.toThrow("SESSION_BINDING_REQUIRED");
      expect(reader).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled(); expect(onFrame).not.toHaveBeenCalled();
    }
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("x-bullet-expected-session")).toBe(expected);
  }
});
