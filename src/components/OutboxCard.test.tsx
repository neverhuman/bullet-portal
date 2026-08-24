import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OutboxItem, OutboxView } from "../generated/api";
import { toUnknown, toValue } from "../loadable";
import { OutboxCard } from "./OutboxCard";

function item(seq: number, phase: string): OutboxItem {
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
  it("colors delivery phases honestly", () => {
    const view: OutboxView = {
      items: [
        item(1, "pending"),
        item(2, "applied"),
        item(3, "verified"),
        item(4, "unknown"),
        item(5, "garbled"),
      ],
    };
    render(<OutboxCard outbox={toValue(view)} />);
    expect(screen.getByTestId("outbox-phase-1")).toHaveClass("pending");
    expect(screen.getByTestId("outbox-phase-2")).toHaveClass("pending");
    expect(screen.getByTestId("outbox-phase-3")).toHaveClass("verified");
    expect(screen.getByTestId("outbox-phase-4")).toHaveClass("unknown");
    expect(screen.getByTestId("outbox-phase-5")).toHaveClass("unknown");
  });

  it("renders empty as verified only from a value, and failure as unknown", () => {
    const { rerender } = render(<OutboxCard outbox={toValue<OutboxView>({ items: [] })} />);
    expect(screen.getByTestId("outbox-empty")).toHaveTextContent("outbox: empty (verified)");
    rerender(
      <OutboxCard
        outbox={toUnknown<OutboxView>("outbox unreachable (GET /v1/outbox failed: HTTP 500)")}
      />,
    );
    expect(screen.queryByTestId("outbox-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("outbox-unknown")).toHaveTextContent("unknown: outbox unreachable");
  });
});
