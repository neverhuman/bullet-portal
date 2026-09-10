import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOperatorSnapshot } from "./api";
import { operatorSnapshotFixture, OPERATOR_OBSERVED_AT } from "./testing/operatorSnapshot";

function response(data: unknown, sequence = 7, header = sequence): Response {
  return new Response(JSON.stringify({ data, as_of_sequence: sequence,
    observed_at: OPERATOR_OBSERVED_AT, source: "bullet-kernel/sqlite-ledger" }), {
    headers: { "content-type": "application/json", "x-bullet-as-of-sequence": String(header) },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("operator snapshot boundary", () => {
  it("reads the generated aggregate through one authenticated same-origin request", async () => {
    const fetch = vi.fn(async () => response(operatorSnapshotFixture(7)));
    vi.stubGlobal("fetch", fetch);
    const read = await fetchOperatorSnapshot();
    expect(read.asOfSequence).toBe(7);
    expect(read.data.audit.latest_sequence).toBe(7);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/v1/operator-snapshot", expect.objectContaining({ credentials: "same-origin" }));
  });

  it.each([
    ["missing component", (data: Record<string, unknown>) => { delete data.sessions; }],
    ["extra component", (data: Record<string, unknown>) => { data.invented = []; }],
    ["malformed nested view", (data: Record<string, unknown>) => { data.fleet = { leases: [] }; }],
    ["missing audit prefix", (data: Record<string, unknown>) => { (data.audit as { events: unknown[] }).events.shift(); }],
    ["audit gap", (data: Record<string, unknown>) => { (data.audit as { events: unknown[] }).events.splice(2, 1); }],
    ["unbound mission graph", (data: Record<string, unknown>) => { data.graphs = [{ mission: {}, packages: [], fence: 0 }]; }],
  ])("rejects %s without a partial result", async (_name, mutate) => {
    const data = operatorSnapshotFixture(7);
    mutate(data);
    vi.stubGlobal("fetch", vi.fn(async () => response(data)));
    await expect(fetchOperatorSnapshot()).rejects.toThrow("schema validation");
  });

  it("rejects an audit watermark that disagrees with the enclosing snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(operatorSnapshotFixture(6))));
    await expect(fetchOperatorSnapshot()).rejects.toThrow("snapshot audit watermark mismatch");
  });

  it("rejects a different header watermark", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(operatorSnapshotFixture(7), 7, 8)));
    await expect(fetchOperatorSnapshot()).rejects.toThrow("snapshot watermark header/body mismatch");
  });
});
