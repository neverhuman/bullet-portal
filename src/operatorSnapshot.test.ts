import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOperatorSnapshot } from "./api";
import { operatorSnapshotFixture, OPERATOR_OBSERVED_AT } from "./testing/operatorSnapshot";
import { forgetBrowserSession } from "./apiSession";
vi.mock("./apiAuth", () => ({ getOperatorSession: vi.fn(async () => ({
  operator_id: `opr_${"1".repeat(64)}`, session_id: `sid_${"2".repeat(64)}`,
})) }));

function response(data: unknown, sequence = 7, header = sequence): Response {
  return new Response(JSON.stringify({ data, as_of_sequence: sequence,
    observed_at: OPERATOR_OBSERVED_AT, source: "bullet-kernel/sqlite-ledger" }), {
    headers: { "content-type": "application/json", "x-bullet-as-of-sequence": String(header), "x-bullet-session-id": `sid_${"2".repeat(64)}` },
  });
}

afterEach(() => { vi.unstubAllGlobals(); forgetBrowserSession(); });

describe("operator snapshot boundary", () => {
  it("binds each populated mission graph and package to the atomic mission subject", async () => {
    const mission = { id: `mis_${"1".repeat(64)}`, organization_id: `org_${"2".repeat(64)}`,
      repository_id: `rep_${"3".repeat(64)}`, title: "durable goal", objective: "bind the graph",
      acceptance_contract_id: `acc_${"4".repeat(64)}`, state: "active" };
    const work = { id: `wpk_${"5".repeat(64)}`, mission_id: mission.id,
      plan_revision_id: `pln_${"6".repeat(64)}`, title: "bounded work", task_class: "bounded_bug_fix", state: "READY" };
    const graph = { mission, packages: [work], fence: 2 };
    const data = { ...operatorSnapshotFixture(7), missions: [mission], graphs: [graph] };
    const fetch = vi.fn(async () => response(data)); vi.stubGlobal("fetch", fetch);
    await expect(fetchOperatorSnapshot()).resolves.toMatchObject({ data: { missions: [mission], graphs: [graph] } });
    for (const graphs of [[{ ...graph, mission: { ...mission, title: "substituted" } }],
      [{ ...graph, mission: { ...mission, id: `mis_${"9".repeat(64)}` } }],
      [{ ...graph, packages: [{ ...work, mission_id: `mis_${"9".repeat(64)}` }] }], [graph, graph]]) {
      fetch.mockImplementationOnce(async () => response({ ...data, graphs }));
      await expect(fetchOperatorSnapshot()).rejects.toThrow("schema validation");
    }
  });
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
