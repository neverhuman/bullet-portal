import { renderObservation } from "../observation";
import type { Surface } from "../surfaces";

/**
 * Card for a surface farmd does not project. The reason names the exact
 * missing ledger subject and the V1 slice that produces it; it is never an
 * empty list and never green.
 */
export function SurfacePage({ surface }: { surface: Surface }) {
  const reason =
    surface.unknownReason ?? "control plane has not published this projection";
  return (
    <section className="card" data-testid={`surface-${surface.id}`}>
      <h1>{surface.title}</h1>
      <p className="tagline">
        spec §{surface.spec} · as_of_sequence unknown · source none · observed_at unknown ·
        freshness unknown · projection unknown · confidence unknown
      </p>
      <p>Answers: {surface.answers}</p>
      <p className="unknown" data-testid={`${surface.id}-unknown`}>
        {renderObservation({ kind: "unknown", text: `${surface.title}: ${reason}` })}
      </p>
    </section>
  );
}
