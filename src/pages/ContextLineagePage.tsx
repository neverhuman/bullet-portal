import { fetchContextLineage } from "../api";
import { ProjectionCard, RowsTable, type Column } from "../components/ProjectionCard";
import type { ContextCapsuleRow, ContextLineageView } from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";

async function loadContextLineage(): Promise<ProjectionRead<ContextLineageView>> {
  const lineage = await fetchContextLineage();
  return { reads: [lineage], body: lineage.data };
}

const CAPSULE_COLUMNS: Column<ContextCapsuleRow>[] = [
  { header: "capsule", cell: (row) => row.id },
  { header: "revision", cell: (row) => String(row.revision) },
  { header: "mission", cell: (row) => row.mission_id },
  { header: "work_package", cell: (row) => row.work_package_id },
  { header: "plan_revision", cell: (row) => row.plan_revision_id },
  { header: "task_class", cell: (row) => row.task_class },
  { header: "schema", cell: (row) => row.schema_version },
  { header: "parent", cell: (row) => (row.parent_id === null ? "none (initial root)" : row.parent_id) },
  { header: "compression", cell: (row) => row.compression },
  { header: "dropped_decisions", cell: (row) => String(row.dropped_decision_digests.length) },
  { header: "content_digest", cell: (row) => row.content_digest },
  { header: "objective_digest", cell: (row) => row.objective_digest },
  { header: "package_title_digest", cell: (row) => row.package_title_digest },
  { header: "recorded_at", cell: (row) => row.recorded_at },
];

export function ContextLineagePage({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadContextLineage);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body, asOf) => (
        <>
          <p data-testid="context-lineage-summary">
            initial revision-one capsules {body.capsules.length} · compression none only · raw
            objective and package title unavailable (digests only) · no successor lineage claimed
          </p>
          <RowsTable
            id="context-lineage-capsules"
            label="context capsules"
            asOf={asOf}
            columns={CAPSULE_COLUMNS}
            rows={body.capsules}
          />
        </>
      )}
    </ProjectionCard>
  );
}
