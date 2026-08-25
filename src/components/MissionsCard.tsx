import type { Mission } from "../generated/api";
import type { Loadable } from "../loadable";
import { renderObservation } from "../observation";

export function MissionsCard({ missions }: { missions: Loadable<Mission[]> }) {
  return (
    <section className="card">
      <h2>Missions</h2>
      <MissionsBody missions={missions} />
    </section>
  );
}

function MissionsBody({ missions }: { missions: Loadable<Mission[]> }) {
  if (missions.kind === "loading") {
    return <p className="idle">loading missions</p>;
  }
  if (missions.kind === "unknown") {
    return (
      <>
        <p className="unknown" data-testid="missions-unknown">
          {renderObservation({ kind: "unknown", text: missions.reason })}
        </p>
        <p className="source">source: {missions.source} (observed {missions.observedAt})</p>
      </>
    );
  }
  return (
    <>
      {missions.value.length === 0 ? <p data-testid="missions-empty">No missions yet.</p> : null}
      <ul>
        {missions.value.map((mission) => (
          <li key={mission.id}>
            {mission.title} — {mission.state} ({mission.id})
          </li>
        ))}
      </ul>
      <p className="source">source: {missions.source} via GET /api/v1/missions (observed {missions.observedAt})</p>
    </>
  );
}
