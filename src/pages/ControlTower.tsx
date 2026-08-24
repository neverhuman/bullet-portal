import { useEffect, useState } from "react";
import { listMissions, runDemo } from "../api";
import type { DemoReceipt, Mission } from "../generated/api";
import { renderObservation } from "../observation";

type MutationPhase = "idle" | "pending" | "verified";

export function ControlTower() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [receipt, setReceipt] = useState<DemoReceipt | null>(null);
  const [phase, setPhase] = useState<MutationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const unknownProbe = renderObservation({
    kind: "unknown",
    text: "quota probe did not return",
  });

  useEffect(() => {
    listMissions()
      .then(setMissions)
      .catch(() => {
        setMissions([]);
      });
  }, []);

  async function onRunDemo() {
    setPhase("pending");
    setError(null);
    try {
      const next = await runDemo();
      setReceipt(next);
      setPhase("verified");
      setMissions(await listMissions());
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : "demo failed");
    }
  }

  return (
    <main>
      <h1>Control Tower</h1>
      <p className="tagline">Many minds. One verified line to main.</p>
      <button type="button" onClick={() => void onRunDemo()}>
        Run simulator demo
      </button>
      <p className={phase === "pending" ? "pending" : "verified"} data-testid="phase">
        mutation phase: {phase}
      </p>
      <p className="unknown" data-testid="unknown-probe">
        {unknownProbe}
      </p>
      {error ? <p className="unknown">{error}</p> : null}
      <section className="card">
        <h2>Missions</h2>
        {missions.length === 0 ? <p>No missions yet.</p> : null}
        <ul>
          {missions.map((mission) => (
            <li key={mission.id}>
              {mission.title} — {mission.state} ({mission.id})
            </li>
          ))}
        </ul>
      </section>
      {receipt ? (
        <section className="card" data-testid="receipt">
          <h2>Demo receipt</h2>
          <dl>
            <dt>mission</dt>
            <dd>{receipt.mission_id}</dd>
            <dt>fence</dt>
            <dd>{receipt.fence}</dd>
            <dt>live attempt</dt>
            <dd>{receipt.attempt_id}</dd>
            <dt>stale attempt</dt>
            <dd>{receipt.stale_attempt_id}</dd>
            <dt>stale refused</dt>
            <dd>{String(receipt.stale_refused)}</dd>
            <dt>evidence</dt>
            <dd>{receipt.evidence_result}</dd>
            <dt>effect</dt>
            <dd>{receipt.effect_outcome}</dd>
          </dl>
        </section>
      ) : null}
    </main>
  );
}
