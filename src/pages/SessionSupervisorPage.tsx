import { fetchSessions } from "../api";
import { nullable, ProjectionCard, RowsTable, type Column } from "../components/ProjectionCard";
import type { AttemptRow, LabelCount, SessionSupervisorView } from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";

async function loadSessions(): Promise<ProjectionRead<SessionSupervisorView>> {
  const sessions = await fetchSessions();
  return { reads: [sessions], body: sessions.data };
}

export const COUNT_COLUMNS: Column<LabelCount>[] = [
  { header: "label", cell: (row) => row.label },
  { header: "count", cell: (row) => String(row.count) },
];

const ATTEMPT_COLUMNS: Column<AttemptRow>[] = [
  { header: "state", cell: (row) => row.state },
  { header: "lease", cell: (row) => row.lease },
  { header: "attempt", cell: (row) => row.id },
  { header: "fence", cell: (row) => String(row.fence) },
  { header: "variant", cell: (row) => row.variant_id },
  { header: "work_package", cell: (row) => row.work_package_id },
  { header: "mission", cell: (row) => nullable(row.mission_id, "unknown (no graph names it)") },
  { header: "runner", cell: (row) => `${row.runner_id} epoch ${row.runner_epoch}` },
  { header: "workspace", cell: (row) => row.workspace_id },
  { header: "scope/context rev", cell: (row) => `${row.scope_revision}/${row.context_revision}` },
  { header: "leased_at", cell: (row) => nullable(row.leased_at, "not recorded") },
  {
    header: "last_lease_event",
    cell: (row) =>
      row.last_lease_event === null
        ? "none recorded"
        : `${row.last_lease_event.kind} @ ${row.last_lease_event.at} (seq ${row.last_lease_event.seq})`,
  },
];

export function SessionSupervisorPage({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadSessions);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body, asOf) => (
        <>
          <p data-testid="sessions-summary">
            attempts {body.attempts.length} · lease held{" "}
            {body.attempts.filter((row) => row.lease === "held").length} · timestamps come only from
            durable lease events (attempt rows carry none)
          </p>
          <RowsTable
            id="sessions-states"
            label="attempts by state"
            asOf={asOf}
            columns={COUNT_COLUMNS}
            rows={body.state_counts}
          />
          <RowsTable
            id="sessions-attempts"
            label="attempt rows"
            asOf={asOf}
            columns={ATTEMPT_COLUMNS}
            rows={body.attempts}
          />
        </>
      )}
    </ProjectionCard>
  );
}
