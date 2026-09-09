import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  errorText,
  exchangeBootstrap,
  fetchOutbox,
  forgetBrowserSession,
  getCommand,
  hasSessionMaterial,
  listMissions,
  newRunCodingEnvelope,
  type CodingProviderName,
  submitCommand,
} from "../api";
import {
  clearPendingCommandIf,
  envelopeForRetryOrCreate,
  loadPendingCommand,
  PendingCommandError,
  rememberAdmittedCommand,
  restoredSubjectConflicts,
} from "../pendingCommand";
import { CommandCard } from "../components/CommandCard";
import { MissionsCard } from "../components/MissionsCard";
import { OutboxCard } from "../components/OutboxCard";
import { StatusHeader } from "../components/StatusHeader";
import type { CommandEnvelope, CommandStatus, Mission, OutboxView } from "../generated/api";
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

function codingFields(
  accountId: string,
  provider: CodingProviderName,
  model: string,
): { accountId: string; provider: CodingProviderName; model: string } {
  return { accountId, provider, model };
}

function pendingCodingConflicts(
  accountId: string,
  provider: CodingProviderName,
  model: string,
): boolean {
  const pending = loadPendingCommand();
  if (pending === null) return false;
  if (pending.envelope.kind !== "run_coding") return true;
  const payload = pending.envelope.payload as Record<string, unknown>;
  return (
    payload.account_id !== accountId ||
    payload.provider !== provider ||
    payload.model !== model
  );
}

export function ControlTower() {
  const [missions, setMissions] = useState<Loadable<Mission[]>>({ kind: "loading" });
  const [outbox, setOutbox] = useState<Loadable<OutboxView>>({ kind: "loading" });
  const [command, setCommand] = useState<CommandStatus | null>(null);
  const [phase, setPhase] = useState<MutationPhase>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("acct-local");
  const [model, setModel] = useState("claude-opus-4-6");
  const [provider, setProvider] = useState<CodingProviderName>("claude");
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

  async function reconcile(initial: CommandStatus, generation: number, envelope: CommandEnvelope): Promise<void> {
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
      if (commandGeneration.current !== generation) return;
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
        if (commandGeneration.current === generation) {
          clearPendingCommandIf({
            commandId: next.id,
            kind: next.kind,
            payloadDigest: next.payload_digest,
          }, envelope);
        }
        return;
      }
      last = next;
      setCommand(next);
      setPhase(next.status);
    }
    runningRef.current = false;
    if (commandGeneration.current === generation) {
      clearPendingCommandIf({
        commandId: last.id,
        kind: last.kind,
        payloadDigest: last.payload_digest,
      }, envelope);
    }
    if (last.status === "FAILED" || last.status === "UNKNOWN") {
      setCommand(last);
      setPhase(last.status);
      setError(`command ${last.id} durably ${last.status}`);
      return;
    }
    setCommand(last);
    setPhase("UNKNOWN");
    setError(unverifiableSuccess(last.id));
  }

  async function resumePending(): Promise<void> {
    if (runningRef.current) return;
    const generation = commandGeneration.current + 1;
    commandGeneration.current = generation;
    try {
      const pending = loadPendingCommand();
      if (pending === null) return;
      if (pendingCodingConflicts(accountId, provider, model)) {
        throw new PendingCommandError("pending command conflicts with the coding action; reconcile it first");
      }
      if (pending.commandId === null) return;
      runningRef.current = true;
      setPhase("PENDING");
      setError(null);
      const admitted = await getCommand(pending.commandId);
      if (commandGeneration.current !== generation) return;
      if (restoredSubjectConflicts(pending, admitted)) {
        throw new PendingCommandError(
          `command ${pending.commandId} restored subject conflicts with persisted kind or digest`,
        );
      }
      setCommand(admitted);
      await reconcile(admitted, generation, pending.envelope);
    } catch (err) {
      if (commandGeneration.current !== generation) return;
      setPhase("UNKNOWN");
      setError(`command reconciliation unknown (${errorText(err)})`);
      runningRef.current = false;
    }
  }

  useEffect(() => {
    void resumePending();
    return () => {
      commandGeneration.current += 1;
      runningRef.current = false;
    };
  }, []);

  async function onRunCoding(): Promise<void> {
    if (runningRef.current) return;
    let generation = commandGeneration.current;
    try {
      const pending = loadPendingCommand();
      if (pendingCodingConflicts(accountId, provider, model)) {
        throw new PendingCommandError("pending command conflicts with the coding action; reconcile it first");
      }
      if (pending?.commandId !== null && pending?.commandId !== undefined) {
        await resumePending();
        return;
      }
      const fields = codingFields(accountId, provider, model);
      const envelope = envelopeForRetryOrCreate(() => newRunCodingEnvelope(fields));
      runningRef.current = true;
      generation = commandGeneration.current + 1;
      commandGeneration.current = generation;
      setPhase("PENDING");
      setError(null);
      setCommand(null);
      const admitted = await submitCommand(envelope);
      if (commandGeneration.current !== generation) return;
      setCommand(admitted);
      setPhase("PENDING");
      const persisted = rememberAdmittedCommand({
        commandId: admitted.id,
        kind: admitted.kind,
        payloadDigest: admitted.payload_digest,
      }, envelope);
      if (!persisted) {
        setPhase("UNKNOWN");
        setError(`command ${admitted.id} admitted but persistence failed; retry will reuse the envelope`);
      }
      await reconcile(admitted, generation, envelope);
    } catch (err) {
      if (commandGeneration.current !== generation) return;
      const custodyFailure = err instanceof PendingCommandError;
      const ambiguous = err instanceof ApiError && err.outcomeUnknown;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        forgetBrowserSession();
        setSessionMaterial(false);
      }
      setPhase(ambiguous || custodyFailure ? "UNKNOWN" : "FAILED");
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
      <label htmlFor="coding-account">Account</label>{" "}
      <input
        id="coding-account"
        data-testid="coding-account"
        value={accountId}
        onChange={(event) => setAccountId(event.target.value)}
      />{" "}
      <label htmlFor="coding-model">Model</label>{" "}
      <input
        id="coding-model"
        data-testid="coding-model"
        value={model}
        onChange={(event) => setModel(event.target.value)}
      />{" "}
      <label htmlFor="coding-provider">Provider</label>{" "}
      <select
        id="coding-provider"
        data-testid="coding-provider"
        value={provider}
        onChange={(event) => setProvider(event.target.value as CodingProviderName)}
      >
        <option value="claude">claude</option>
        <option value="codex">codex</option>
        <option value="cursor">cursor</option>
        <option value="antigravity">antigravity</option>
      </select>{" "}
      <button
        type="button"
        disabled={!sessionMaterial || runningRef.current}
        onClick={() => void onRunCoding()}
      >
        Submit durable coding command
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
