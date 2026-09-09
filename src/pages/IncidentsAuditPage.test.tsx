import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceById, type Surface } from "../surfaces";
import { IncidentsAuditPage } from "./IncidentsAuditPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(data: unknown, sequence = "3", header = sequence): Response {
  return new Response(
    JSON.stringify({
      data,
      as_of_sequence: Number(sequence),
      observed_at: "2026-08-25T00:00:00.000Z",
      source: "bullet-kernel/sqlite-ledger",
    }),
    { status: 200, headers: { "content-type": "application/json", "x-bullet-as-of-sequence": header } },
  );
}

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

function surface(idValue: string): Surface {
  const found = surfaceById(idValue);
  if (found === undefined) {
    throw new Error(`${idValue} surface missing`);
  }
  return found;
}

function event(seq: number, kind = "fixture") {
  return {
    id: "f".repeat(64),
    seq,
    at: "2026-08-25T00:00:00.000Z",
    kind,
    body: String(seq),
    stream_id: null,
    correlation_id: null,
  };
}

function routes(auditSequence: string, outboxSequence = auditSequence, events = [event(1), event(2), event(3)]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/v1/audit")) {
      return json(
        { latest_sequence: Number(auditSequence), tail_window: 64, events: events.slice(0, Number(auditSequence)) },
        auditSequence,
      );
    }
    if (url.endsWith("/api/v1/outbox")) {
      return json(
        {
          items: Number(outboxSequence) === 0
            ? []
            : [{ seq: 1, kind: "dispatch_attempt", payload: "{}", phase: "unknown", delivered_at: null, acked_at: null }],
        },
        outboxSequence,
      );
    }
    return new Response("missing", { status: 404 });
  });
}

describe("IncidentsAuditPage", () => {
  it("renders unknown when farmd is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    render(<IncidentsAuditPage surface={surface("incidents-audit")} />);
    await waitFor(() => {
      expect(screen.getByTestId("incidents-audit-unknown")).toHaveTextContent("unknown:");
    });
  });

  it("renders an empty log as zero rows verified at sequence 0", async () => {
    vi.stubGlobal("fetch", routes("0"));
    render(<IncidentsAuditPage surface={surface("incidents-audit")} />);
    await waitFor(() => {
      expect(screen.getByTestId("incidents-audit-events-empty")).toHaveTextContent(
        "durable event tail: 0 rows (verified at sequence 0)",
      );
    });
    expect(screen.getByTestId("incidents-audit-outbox-empty")).toHaveTextContent("outbox: 0 rows (verified at sequence 0)");
    expect(screen.getByTestId("incidents-audit-summary")).toHaveTextContent("latest_sequence 0 · tail_window 64 · showing 0 newest events · outbox rows 0");
    expect(screen.getByTestId("surface-incidents-audit").querySelector(".verified")).toBeNull();
  });

  it("renders the event tail and outbox from one watermark", async () => {
    vi.stubGlobal("fetch", routes("3"));
    render(<IncidentsAuditPage surface={surface("incidents-audit")} />);
    await waitFor(() => {
      expect(screen.getByTestId("incidents-audit-events-rows")).toHaveTextContent("fixture");
    });
    expect(screen.getByTestId("incidents-audit-events-rows")).toHaveTextContent("durable event tail: 3 rows (verified at sequence 3)");
    expect(screen.getByTestId("incidents-audit-outbox-rows")).toHaveTextContent("dispatch_attempt");
    expect(screen.getByTestId("incidents-audit-outbox-rows")).toHaveTextContent("not delivered");
    expect(screen.getByTestId("incidents-audit-summary")).toHaveTextContent("latest_sequence 3");
  });

  it("refuses to compose the tail and the outbox from different sequences", async () => {
    vi.stubGlobal("fetch", routes("3", "4"));
    render(<IncidentsAuditPage surface={surface("incidents-audit")} />);
    await waitFor(() => {
      expect(screen.getByTestId("incidents-audit-unknown")).toHaveTextContent("SNAPSHOT_WATERMARK_MISMATCH");
    });
  });

  it("treats a tail that contradicts its watermark as unknown, not a shorter list", async () => {
    vi.stubGlobal("fetch", routes("3", "3", [event(1), event(3), event(4)]));
    render(<IncidentsAuditPage surface={surface("incidents-audit")} />);
    await waitFor(() => {
      expect(screen.getByTestId("incidents-audit-unknown")).toHaveTextContent("schema validation");
    });
  });
});
