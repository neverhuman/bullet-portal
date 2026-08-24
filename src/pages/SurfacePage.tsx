import { renderObservation } from "../observation";
import type { Surface } from "../surfaces";

export function SurfacePage({ surface }: { surface: Surface }) {
  return (
    <section className="card" data-testid={`surface-${surface.id}`}>
      <h1>{surface.title}</h1>
      <p className="tagline">
        spec §{surface.spec} · as_of_sequence unknown · confidence unknown
      </p>
      <p>Answers: {surface.answers}</p>
      <p className="unknown" data-testid={`${surface.id}-unknown`}>
        {renderObservation({
          kind: "unknown",
          text: `${surface.title}: control plane has not published this projection`,
        })}
      </p>
    </section>
  );
}
