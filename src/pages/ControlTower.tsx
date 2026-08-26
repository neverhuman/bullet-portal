import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  errorText,
  exchangeBootstrap,
  fetchOutbox,
  forgetBrowserSession,
  getCommand,
  hasSessionMaterial,
  listMissions,
  newRunDemoEnvelope,
  submitCommand,
} from "../api";
import { CommandCard } from "../components/CommandCard";
import { MissionsCard } from "../components/MissionsCard";
import { OutboxCard } from "../components/OutboxCard";
import { StatusHeader } from "../components/StatusHeader";
import type { CommandStatus, Mission, OutboxView } from "../generated/api";
import { useEventStream } from "../hooks/useEventStream";
import { useHealthProbe } from "../hooks/useHealthProbe";
import type { Loadable } from "../loadable";
import { toSnapshotValue, toUnknown } from "../loadable";

type MutationPhase = "IDLE" | Exclude<CommandStatus["status"], "VERIFIED">;

const PHASE_CLASS: Record<MutationPhase, string> = {
  IDLE: "idle",
  PENDING: "pending",
  APPLIED: "pending",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

const POLL_INTERVAL_MS = 250;

function isTerminal(status: CommandStatus["status"]): boolean {
  return status === "VERIFIED" || status === "FAILED" || status === "UNKNOWN";
}

function regresses(previous: CommandStatus["status"], next: CommandStatus["status"]): boolean {
  return previous === "APPLIED" && next === "PENDING";
}

function waitForPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

function unverifiableSuccess(commandId: string): string {
  return `command ${commandId} reported durable VERIFIED, but no generated runtime Evidence and Effect receipt contract is available; displayed outcome is UNKNOWN`;
}

export function ControlTower() {
  const [missions, setMissions] = useState<Loadable<Mission[]>>({ kind: "loading" });
  const [outbox, setOutbox] = useState<Loadable<OutboxView>>({ kind: "loading" });
  const [command, setCommand] = useState<CommandStatus | null>(null);
  const [phase, setPhase] = useState<MutationPhase>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [sessionMaterial, setSessionMaterial] = useState(hasSessionMaterial);
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const commandGeneration = useRef(0);
  const health = useHealthProbe();

  const refreshMissions = useCallback(async (): Promise<number | null> => {
    try {
      const snapshot = await listMissions();
      setMissions(toSnapshotValue(snapshot.data, snapshot.observedAt, snapshot.source));
      return snapshot.asOfSequence;
    } catch (err) {
      setMissions(toUnknown(`control plane unreachable (${errorText(err)})`));
      return null;
    }
  }, []);

  const refreshOutbox = useCallback(async (): Promise<number | null> => {
    try {
      const snapshot = await fetchOutbox();
      setOutbox(toSnapshotValue(snapshot.data, snapshot.observedAt, snapshot.source));
      return snapshot.asOfSequence;
    } catch (err) {
      setOutbox(toUnknown(`outbox unreachable (${errorText(err)})`));
      return null;
    }
  }, []);

  const refreshSnapshot = useCallback(async (): Promise<number | null> => {
    const [missionsSequence, outboxSequence] = await Promise.all([
      refreshMissions(),
      refreshOutbox(),
    ]);
    return missionsSequence === null || outboxSequence === null
      ? null
      : Math.min(missionsSequence, outboxSequence);
  }, [refreshMissions, refreshOutbox]);

  const stream = useEventStream(refreshSnapshot);

  async function onAuthenticate(): Promise<void> {
    if (authPending || bootstrapToken.trim() === "") {
      return;
    }
    setAuthPending(true);
    setAuthError(null);
    try {
      await exchangeBootstrap(bootstrapToken.trim());
      setBootstrapToken("");
      setSessionMaterial(true);
    } catch (err) {
      setSessionMaterial(false);
      setAuthError(errorText(err));
    } finally {
      setAuthPending(false);
    }
  }

  async function reconcile(initial: CommandStatus, generation: number): Promise<void> {
    let last = initial;
    while (!isTerminal(last.status)) {
      await waitForPoll();
      if (commandGeneration.current !== generation) {
        return;
      }
      let next: CommandStatus;
      try {
        next = await getCommand(initial.id);
      } catch (err) {
        if (commandGeneration.current === generation) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            forgetBrowserSession();
            setSessionMaterial(false);
          }
          setPhase("UNKNOWN");
          setError(`command ${initial.id} reconciliation unknown (${errorText(err)})`);
          runningRef.current = false;
        }
        return;
      }
      if (
        next.id !== initial.id ||
        next.kind !== initial.kind ||
        next.payload_digest !== initial.payload_digest ||
        regresses(last.status, next.status)
      ) {
        setPhase("UNKNOWN");
        setError(`command ${initial.id} reconciliation returned conflicting durable truth`);
        runningRef.current = false;
        return;
      }
      if (next.status === "VERIFIED") {
        setCommand(next);
        setPhase("UNKNOWN");
        setError(unverifiableSuccess(next.id));
        runningRef.current = false;
        return;
      }
      last = next;
      setCommand(next);
      setPhase(next.status);
    }
    runningRef.current = false;
    if (last.status === "FAILED" || last.status === "UNKNOWN") {
      setError(`command ${last.id} durably ${last.status}`);
      return;
    }
    setCommand(last);
    setPhase("UNKNOWN");
    setError(unverifiableSuccess(last.id));
  }

  async function onRunDemo(): Promise<void> {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    const generation = commandGeneration.current + 1;
    commandGeneration.current = generation;
    setPhase("PENDING");
    setError(null);
    setCommand(null);
    try {
      const admitted = await submitCommand(newRunDemoEnvelope());
      if (commandGeneration.current !== generation) {
        return;
      }
      setCommand(admitted);
      setPhase("PENDING");
      await reconcile(admitted, generation);
    } catch (err) {
      const ambiguous = err instanceof ApiError && err.outcomeUnknown;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        forgetBrowserSession();
        setSessionMaterial(false);
      }
      setPhase(ambiguous ? "UNKNOWN" : "FAILED");
      setError(
        ambiguous
          ? `command admission outcome unknown; no command id was received (${errorText(err)})`
          : errorText(err),
      );
      runningRef.current = false;
    }
  }

  return (
    <main>
      <h1>Control Tower</h1>
      <p className="tagline">Many minds. One verified line to main.</p>
      <StatusHeader stream={stream} health={health.state} />
      {sessionMaterial ? (
        <p className="pending" data-testid="auth-state">
          local session material present; farmd revalidates every command
        </p>
      ) : (
        <form
          className="card"
          onSubmit={(event) => {
            event.preventDefault();
            void onAuthenticate();
          }}
        >
          <h2>Local browser session</h2>
          <label htmlFor="bootstrap-token">One-time bootstrap token</label>{" "}
          <input
            id="bootstrap-token"
            type="password"
            autoComplete="off"
            value={bootstrapToken}
            onChange={(event) => setBootstrapToken(event.target.value)}
          />{" "}
          <button type="submit" disabled={authPending || bootstrapToken.trim() === ""}>
            Authenticate local session
          </button>
          {authError !== null ? (
            <p className="failed" data-testid="auth-error">
              {authError}
            </p>
          ) : null}
        </form>
      )}
      <button
        type="button"
        disabled={!sessionMaterial || runningRef.current}
        onClick={() => void onRunDemo()}
      >
        Submit durable demo command
      </button>
      <p className={PHASE_CLASS[phase]} data-testid="phase">
        command phase: {phase}
      </p>
      {error !== null ? (
        <p className={PHASE_CLASS[phase]} data-testid="mutation-error">
          {error}
        </p>
      ) : null}
      <MissionsCard missions={missions} />
      <OutboxCard outbox={outbox} />
      {command !== null ? <CommandCard command={command} /> : null}
    </main>
  );
}
