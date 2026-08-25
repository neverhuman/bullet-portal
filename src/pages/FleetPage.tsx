import { fetchFleet } from "../api";
import { nullable, ProjectionCard, RowsTable, type Column } from "../components/ProjectionCard";
import type { FleetLease, FleetView, ReadyRow } from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";

async function loadFleet(): Promise<ProjectionRead<FleetView>> {
  const fleet = await fetchFleet();
  return { reads: [fleet], body: fleet.data };
}

const LEASE_COLUMNS: Column<FleetLease>[] = [
  { header: "liveness", cell: (row) => row.liveness },
  { header: "variant", cell: (row) => row.variant_id },
  { header: "attempt", cell: (row) => row.attempt_id },
  { header: "fence", cell: (row) => String(row.fence) },
  { header: "runner", cell: (row) => `${row.runner_id} epoch ${row.runner_epoch}` },
  { header: "heartbeat_at", cell: (row) => row.heartbeat_at },
  { header: "expires_at", cell: (row) => row.expires_at },
  { header: "ttl_seconds", cell: (row) => String(row.ttl_seconds) },
  {
    header: "attempt_state",
    cell: (row) => nullable(row.attempt_state, "contradictory: attempt row missing"),
  },
  { header: "work_package", cell: (row) => nullable(row.work_package_id, "unknown") },
  { header: "mission", cell: (row) => nullable(row.mission_id, "unknown") },
];

const READY_COLUMNS: Column<ReadyRow>[] = [
  { header: "work_package", cell: (row) => row.work_package_id },
  { header: "enqueued_at", cell: (row) => row.enqueued_at },
];

function livenessSummary(leases: FleetLease[]): string {
  const count = (liveness: FleetLease["liveness"]): number =>
    leases.filter((lease) => lease.liveness === liveness).length;
  return `live ${count("live")} · expired ${count("expired")} · unknown ${count("unknown")}`;
}

export function FleetPage({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadFleet);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body, asOf) => (
        <>
          <p data-testid="fleet-authority-time">
            authority_time (store clock; liveness basis): {body.authority_time}
          </p>
          <p data-testid="fleet-summary">
            active leases {body.leases.length} ({livenessSummary(body.leases)}) · ready-queue depth{" "}
            {body.ready_queue.length}
          </p>
          <RowsTable
            id="fleet-leases"
            label="active leases"
            asOf={asOf}
            columns={LEASE_COLUMNS}
            rows={body.leases}
          />
          <RowsTable
            id="fleet-ready"
            label="ready queue"
            asOf={asOf}
            columns={READY_COLUMNS}
            rows={body.ready_queue}
          />
        </>
      )}
    </ProjectionCard>
  );
}
