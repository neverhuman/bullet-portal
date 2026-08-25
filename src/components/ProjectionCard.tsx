import { useEffect, useState, type ReactNode } from "react";
import type { ProjectionLoad } from "../hooks/useProjection";
import { renderObservation } from "../observation";
import type { Surface } from "../surfaces";

const FRESHNESS_TICK_MS = 5_000;

function ageSeconds(observedAt: string, nowMs: number): string {
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
    return "unknown (unparseable observed_at)";
  }
  return `${Math.max(0, Math.round((nowMs - observedMs) / 1000))}s since observed_at (one-shot snapshot, not live)`;
}

function Freshness({ load }: { load: ProjectionLoad<unknown> }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (load.kind !== "value") {
      return;
    }
    const timer = setInterval(() => setNowMs(Date.now()), FRESHNESS_TICK_MS);
    return () => clearInterval(timer);
  }, [load.kind]);
  return <>{load.kind === "value" ? ageSeconds(load.observedAt, nowMs) : "unknown"}</>;
}

/**
 * Shell for every farmd-projected surface. The header always shows as_of,
 * source, observed_at, freshness, and projection status; loading and unknown
 * are explicit states, never an empty success.
 */
export function ProjectionCard<T>({
  surface,
  load,
  children,
}: {
  surface: Surface;
  load: ProjectionLoad<T>;
  children: (body: T, asOf: number) => ReactNode;
}) {
  const status = load.kind === "value" ? "published" : load.kind;
  return (
    <section className="card" data-testid={`surface-${surface.id}`}>
      <h1>{surface.title}</h1>
      <p className="tagline" data-testid={`${surface.id}-tagline`}>
        spec §{surface.spec} · as_of_sequence {load.kind === "value" ? load.asOf : "unknown"} ·
        source {load.kind === "loading" ? "unknown" : load.source} · observed_at{" "}
        {load.kind === "loading" ? "unknown" : load.observedAt} · freshness <Freshness load={load} />{" "}
        · projection {status} · confidence {load.kind === "value" ? "published" : "unknown"}
      </p>
      <p>Answers: {surface.answers}</p>
      {load.kind === "loading" ? (
        <p className="idle" data-testid={`${surface.id}-loading`}>
          loading projection
        </p>
      ) : load.kind === "unknown" ? (
        <p className="unknown" data-testid={`${surface.id}-unknown`}>
          {renderObservation({ kind: "unknown", text: load.text })}
        </p>
      ) : (
        children(load.body, load.asOf)
      )}
    </section>
  );
}

export type Column<R> = { header: string; cell: (row: R) => string };

/**
 * A verified table. Zero rows renders as "0 rows (verified at sequence N)" in
 * the neutral idle style: an empty set is a fact about the ledger, not health.
 */
export function RowsTable<R>({
  id,
  label,
  asOf,
  columns,
  rows,
}: {
  id: string;
  label: string;
  asOf: number;
  columns: Column<R>[];
  rows: R[];
}) {
  if (rows.length === 0) {
    return (
      <p className="idle" data-testid={`${id}-empty`}>
        {label}: 0 rows (verified at sequence {asOf})
      </p>
    );
  }
  return (
    <div className="rows" data-testid={`${id}-rows`}>
      <p className="idle">
        {label}: {rows.length} rows (verified at sequence {asOf})
      </p>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.header}>{column.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function nullable(value: string | null, absent: string): string {
  return value === null ? absent : value;
}
