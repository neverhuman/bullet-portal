import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getOperatorSession } from "../apiAuth";
import { ApiError } from "../apiTransport";
import { forgetBrowserSession } from "../apiSession";
import { useEventStream } from "./useEventStream";

vi.mock("../apiAuth", () => ({ getOperatorSession: vi.fn() }));
const session = { status: "AUTHENTICATED" as const, operator_id: `opr_${"1".repeat(64)}`,
  session_id: `sid_${"2".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" };
afterEach(() => { cleanup(); forgetBrowserSession(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("retries transient owner discovery and connects without a remount or authentication change", async () => {
  vi.useFakeTimers();
  vi.mocked(getOperatorSession).mockRejectedValueOnce(new ApiError("GET", "/auth/session", null, "network unavailable"))
    .mockResolvedValue(session);
  const cancel = vi.fn();
  const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
    headers: { "content-type": "text/event-stream", "x-bullet-session-id": session.session_id },
  }));
  vi.stubGlobal("fetch", fetch);
  const onGap = vi.fn(async () => 7);
  const { result } = renderHook(() => useEventStream(onGap));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.connection).toBe("unknown");
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
  expect(result.current.connection).toBe("live");
  expect(onGap).toHaveBeenCalledWith(0);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/events?after=7", expect.objectContaining({
    headers: expect.objectContaining({ "x-bullet-expected-session": session.session_id }),
  }));
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
