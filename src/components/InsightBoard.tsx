import type { FleetView, SessionSupervisorView } from "../generated/api";
import type { Loadable } from "../loadable";
import { renderObservation } from "../observation";

function countLiveness(fleet: FleetView, liveness: FleetView["leases"][number]["liveness"]): number {
  return fleet.leases.filter((lease) => lease.liveness === liveness).length;
}

function heldLeases(sessions: SessionSupervisorView): number {
  return sessions.attempts.filter((row) => row.lease === "held").length;
}

function Chip({
  testId,
  load,
  label,
}: {
  testId: string;
  load: Loadable<unknown>;
  label: (value: unknown) => { className: string; text: string };
}) {
  if (load.kind === "loading") {
    return (
      <span className="chip chip-idle" data-testid={testId}>
        checking
      </span>
    );
  }
  if (load.kind === "unknown") {
    return (
      <span className="chip chip-unknown" data-testid={testId}>
        unknown: {renderObservation({ kind: "unknown", text: load.reason })}
      </span>
    );
  }
  const painted = label(load.value);
  return (
    <span className={`chip ${painted.className}`} data-testid={testId}>
      {painted.text}
    </span>
  );
}

export function InsightBoard({
  fleet,
  sessions,
  sessionMaterial,
}: {
  fleet: Loadable<FleetView>;
  sessions: Loadable<SessionSupervisorView>;
  sessionMaterial: boolean;
}) {
  return (
    <section className="card insight-board" data-testid="insight-board">
      <h2>Live board</h2>
      <p className="chip chip-hold" data-testid="hold-banner">
        HOLD operating hold remains · stop STOP_UNIMPLEMENTED · no session steer
      </p>
      {!sessionMaterial ? (
        <p className="idle" data-testid="insight-session">
          authenticate the local browser session to read fleet and sessions
        </p>
      ) : (
        <div className="insight-chips">
          <Chip
            testId="insight-fleet"
            load={fleet}
            label={(value) => {
              const body = value as FleetView;
              const live = countLiveness(body, "live");
              return {
                className: live > 0 ? "chip-live" : "chip-idle",
                text: `fleet LIVE ${live} · EXPIRED ${countLiveness(body, "expired")} · UNKNOWN ${countLiveness(body, "unknown")} · ready ${body.ready_queue.length}`,
              };
            }}
          />
          <Chip
            testId="insight-sessions"
            load={sessions}
            label={(value) => {
              const body = value as SessionSupervisorView;
              const held = heldLeases(body);
              return {
                className: held > 0 ? "chip-live" : "chip-idle",
                text: `sessions attempts ${body.attempts.length} · HELD ${held}`,
              };
            }}
          />
        </div>
      )}
      <p className="source" data-testid="insight-honesty">
        GET /api/v1/fleet and /api/v1/sessions only. Empty is zero rows, not a green multi-agent
        process. Six spec surfaces still have no ledger subject.
      </p>
    </section>
  );
}
