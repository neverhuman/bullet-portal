import { fetchQualityLab } from "../api";
import { ProjectionCard, RowsTable, type Column } from "../components/ProjectionCard";
import type { EvidenceRow, QualityLabView } from "../generated/api";
import { useProjection, type ProjectionRead } from "../hooks/useProjection";
import type { Surface } from "../surfaces";
import { COUNT_COLUMNS } from "./SessionSupervisorPage";

async function loadQualityLab(): Promise<ProjectionRead<QualityLabView>> {
  const lab = await fetchQualityLab();
  return { reads: [lab], body: lab.data };
}

const EVIDENCE_COLUMNS: Column<EvidenceRow>[] = [
  { header: "outcome", cell: (row) => row.outcome },
  { header: "satisfies_requirement", cell: (row) => String(row.satisfies_requirement) },
  { header: "tier", cell: (row) => row.tier },
  { header: "gate", cell: (row) => row.gate },
  { header: "stored result", cell: (row) => row.result },
  { header: "evidence", cell: (row) => row.id },
  { header: "candidate", cell: (row) => row.candidate_id },
];

export function QualityLabPage({ surface }: { surface: Surface }) {
  const load = useProjection(surface.title, loadQualityLab);
  return (
    <ProjectionCard surface={surface} load={load}>
      {(body, asOf) => (
        <>
          <p data-testid="quality-lab-summary">
            evidence rows {body.evidence.length} · PASS{" "}
            {body.evidence.filter((row) => row.satisfies_requirement).length} · only typed PASS
            satisfies a requirement
          </p>
          <RowsTable
            id="quality-lab-outcomes"
            label="GateOutcome histogram"
            asOf={asOf}
            columns={COUNT_COLUMNS}
            rows={body.outcome_counts}
          />
          <RowsTable
            id="quality-lab-evidence"
            label="evidence rows"
            asOf={asOf}
            columns={EVIDENCE_COLUMNS}
            rows={body.evidence}
          />
        </>
      )}
    </ProjectionCard>
  );
}
