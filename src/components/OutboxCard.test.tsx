import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OutboxItem, OutboxView } from "../generated/api";
import { toSnapshotValue, toUnknown, toValue } from "../loadable";
import { OutboxCard } from "./OutboxCard";

function item(seq: number, phase: OutboxItem["phase"]): OutboxItem {
  return {
    seq,
    kind: "dispatch_attempt",
    payload: "{}",
    phase,
    delivered_at: null,
    acked_at: null,
  };
}

describe("OutboxCard", () => {
  it("refuses a generic verified outbox phase without runtime receipts", () => {
    const malformed = { ...item(5, "unknown"), phase: "garbled" } as unknown as OutboxItem;
    const view: OutboxView = {
      items: [
        item(1, "pending"),
        item(2, "applied"),
        item(3, "verified"),
        item(4, "unknown"),
        malformed,
      ],
    };
    render(<OutboxCard outbox={toValue(view)} />);
    expect(screen.getByTestId("outbox-phase-1")).toHaveClass("pending");
    expect(screen.getByTestId("outbox-phase-2")).toHaveClass("pending");
    expect(screen.getByTestId("outbox-phase-3")).toHaveClass("unknown");
    expect(screen.getByTestId("outbox-phase-3")).not.toHaveClass("verified");
    expect(screen.getByTestId("outbox-phase-3")).toHaveTextContent(
      "verified (receipt unavailable)",
    );
    expect(screen.getByTestId("outbox-phase-4")).toHaveClass("unknown");
    expect(screen.getByTestId("outbox-phase-5")).toHaveClass("unknown");
  });

  it("renders observed empty neutrally only from a value, and failure as unknown", () => {
    const { rerender } = render(
      <OutboxCard
        outbox={toSnapshotValue(
          { items: [] },
          "2026-08-24T22:00:00.000Z",
          "bullet-kernel/sqlite-ledger",
        )}
      />,
    );
    expect(screen.getByTestId("outbox-empty")).toHaveTextContent("outbox: empty (observed)");
    expect(screen.getByTestId("outbox-empty")).toHaveClass("idle");
    expect(screen.getByTestId("outbox-empty")).not.toHaveClass("verified");
    expect(screen.getByText(/source: bullet-kernel\/sqlite-ledger/)).toHaveTextContent(
      "observed 2026-08-24T22:00:00.000Z",
    );
    rerender(
      <OutboxCard
        outbox={toUnknown<OutboxView>("outbox unreachable (GET /api/v1/outbox failed: HTTP 500)")}
      />,
    );
    expect(screen.queryByTestId("outbox-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("outbox-unknown")).toHaveTextContent("unknown: outbox unreachable");
    expect(screen.getByText(/source: portal\/local/)).toBeInTheDocument();
  });
});
