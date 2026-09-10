import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectionLoad } from "../hooks/useProjection";
import { surfaceById, type Surface } from "../surfaces";
import { ProjectionCard, RowsTable } from "./ProjectionCard";

function fleet(): Surface {
  const surface = surfaceById("fleet");
  if (surface === undefined) {
    throw new Error("fleet surface missing");
  }
  return surface;
}

describe("ProjectionCard", () => {
  it("never claims a current snapshot when only the event stream is healthy", () => {
    const stream = { connection: "live" as const, detail: "", asOfSequence: 8, lastEventAt: null, stale: false };
    const { rerender } = render(
      <ProjectionCard surface={fleet()} load={{ kind: "loading", stream }}>{() => <p>never</p>}</ProjectionCard>,
    );
    expect(screen.getByText("Snapshot loading")).toBeInTheDocument();
    expect(screen.queryByText("Snapshot current through event cursor")).toBeNull();
    rerender(
      <ProjectionCard surface={fleet()} load={{ kind: "unknown", text: "read failed", source: "portal/local", observedAt: "2026-09-09T23:00:00Z", stream }}>
        {() => <p>never</p>}
      </ProjectionCard>,
    );
    expect(screen.getByText("Snapshot UNKNOWN")).toHaveClass("unknown");
    expect(screen.queryByText("Snapshot current through event cursor")).toBeNull();
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent("projection unknown");
  });

  it("keeps an event cursor ahead of displayed rows visibly stale until a covering snapshot arrives", () => {
    const refresh = vi.fn();
    const load: ProjectionLoad<string> = {
      kind: "value", body: "rows", asOf: 7, observedAt: "2026-09-09T23:00:00Z",
      source: "bullet-kernel/sqlite-ledger", refresh,
      stream: { connection: "live", detail: "", asOfSequence: 8, lastEventAt: null, stale: false },
    };
    const { rerender } = render(<ProjectionCard surface={fleet()} load={load}>{(body) => <p>{body}</p>}</ProjectionCard>);
    expect(screen.getByText("STALE")).toBeInTheDocument();
    expect(screen.getByText("snapshot 7")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent("projection stale");
    fireEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<ProjectionCard surface={fleet()} load={{ ...load, asOf: 8 }}>{(body) => <p>{body}</p>}</ProjectionCard>);
    expect(screen.queryByText("STALE")).toBeNull();
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent("projection published");
    expect(screen.getByTestId("surface-fleet").querySelector(".verified")).toBeNull();
  });

  it("shows loading as an explicit state with every header field unknown", () => {
    const load: ProjectionLoad<number> = { kind: "loading" };
    render(
      <ProjectionCard surface={fleet()} load={load}>
        {() => <p>never</p>}
      </ProjectionCard>,
    );
    expect(screen.getByTestId("fleet-loading")).toHaveTextContent("loading projection");
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent(
      "as_of_sequence unknown · source unknown · observed_at unknown · freshness unknown · projection loading · confidence unknown",
    );
    expect(screen.queryByText("never")).toBeNull();
  });

  it("renders unknown in the unknown style and never green", () => {
    const load: ProjectionLoad<number> = {
      kind: "unknown",
      text: "Fleet: control plane unreachable (ECONNREFUSED)",
      observedAt: "2026-08-25T00:00:00.000Z",
      source: "portal/local",
    };
    render(
      <ProjectionCard surface={fleet()} load={load}>
        {() => <p>never</p>}
      </ProjectionCard>,
    );
    const unknown = screen.getByTestId("fleet-unknown");
    expect(unknown).toHaveTextContent("unknown: Fleet: control plane unreachable (ECONNREFUSED)");
    expect(unknown).toHaveClass("unknown");
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent("projection unknown");
    expect(screen.getByTestId("fleet-tagline")).toHaveTextContent("source portal/local");
    expect(screen.getByTestId("surface-fleet").querySelector(".verified")).toBeNull();
  });

  it("renders a published value with as_of, source, observed_at, and freshness", () => {
    const load: ProjectionLoad<string> = {
      kind: "value",
      asOf: 7,
      observedAt: "2026-08-25T00:00:00.000Z",
      source: "bullet-kernel/sqlite-ledger",
      body: "payload",
    };
    render(
      <ProjectionCard surface={fleet()} load={load}>
        {(body, asOf) => (
          <p data-testid="child">
            {body} at {asOf}
          </p>
        )}
      </ProjectionCard>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("payload at 7");
    const tagline = screen.getByTestId("fleet-tagline");
    expect(tagline).toHaveTextContent("as_of_sequence 7");
    expect(tagline).toHaveTextContent("source bullet-kernel/sqlite-ledger");
    expect(tagline).toHaveTextContent("observed_at 2026-08-25T00:00:00.000Z");
    expect(tagline).toHaveTextContent(/freshness \d+s since observed_at \(one-shot snapshot, not live\)/);
    expect(tagline).toHaveTextContent("projection published");
  });
});

describe("RowsTable", () => {
  it("renders zero rows as verified-at-sequence in the idle style, not green", () => {
    render(<RowsTable id="t" label="active leases" asOf={9} columns={[]} rows={[]} />);
    const empty = screen.getByTestId("t-empty");
    expect(empty).toHaveTextContent("active leases: 0 rows (verified at sequence 9)");
    expect(empty).toHaveClass("idle");
    expect(empty).not.toHaveClass("verified");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders rows through the column cells with the verified sequence", () => {
    render(
      <RowsTable
        id="t"
        label="rows"
        asOf={9}
        columns={[{ header: "name", cell: (row: { name: string }) => row.name.toUpperCase() }]}
        rows={[{ name: "alpha" }, { name: "beta" }]}
      />,
    );
    expect(screen.getByTestId("t-rows")).toHaveTextContent("rows: 2 rows (verified at sequence 9)");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("ALPHA")).toBeInTheDocument();
  });
});
