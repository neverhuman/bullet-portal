import { fetchAudit, fetchOutbox } from "../api";
import { nullable, ProjectionCard, RowsTable, type Column } from "../components/ProjectionCard";
import type { AuditEvent, AuditView, OutboxItem, OutboxView } from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";

type AuditBody = { audit: AuditView; outbox: OutboxView };

/** Two snapshot reads composed under the watermark cross-check. */
async function loadAudit(): Promise<ProjectionRead<AuditBody>> {
  const [audit, outbox] = await Promise.all([fetchAudit(), fetchOutbox()]);
  return { reads: [audit, outbox], body: { audit: audit.data, outbox: outbox.data } };
}

const EVENT_COLUMNS: Column<AuditEvent>[] = [
  { header: "seq", cell: (row) => String(row.seq) },
  { header: "at", cell: (row) => row.at },
  { header: "kind", cell: (row) => row.kind },
  { header: "stream", cell: (row) => nullable(row.stream_id, "none") },
  { header: "correlation", cell: (row) => nullable(row.correlation_id, "none") },
  { header: "body", cell: (row) => row.body },
];

const OUTBOX_COLUMNS: Column<OutboxItem>[] = [
  { header: "seq", cell: (row) => String(row.seq) },
  { header: "phase", cell: (row) => row.phase },
  { header: "kind", cell: (row) => row.kind },
  { header: "delivered_at", cell: (row) => nullable(row.delivered_at, "not delivered") },
  { header: "acked_at", cell: (row) => nullable(row.acked_at, "not acked") },
  { header: "payload", cell: (row) => row.payload },
];

export function IncidentsAuditPage({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadAudit);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body, asOf) => (
        <>
          <p data-testid="incidents-audit-summary">
            latest_sequence {body.audit.latest_sequence} · tail_window {body.audit.tail_window} ·
            showing {body.audit.events.length} newest events · outbox rows {body.outbox.items.length}
          </p>
          <RowsTable
            id="incidents-audit-events"
            label="durable event tail"
            asOf={asOf}
            columns={EVENT_COLUMNS}
            rows={body.audit.events}
          />
          <RowsTable
            id="incidents-audit-outbox"
            label="outbox"
            asOf={asOf}
            columns={OUTBOX_COLUMNS}
            rows={body.outbox.items}
          />
        </>
      )}
    </ProjectionCard>
  );
}
