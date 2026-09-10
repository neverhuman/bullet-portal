import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  errorText,
  forgetBrowserSession,
  getCommand,
  hasSessionMaterial,
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
import { CommandHistory } from "../components/CommandHistory";
import { InsightBoard } from "../components/InsightBoard";
import { MissionsCard } from "../components/MissionsCard";
import { OutboxCard } from "../components/OutboxCard";
import { StatusHeader } from "../components/StatusHeader";
import { OperatorSession } from "../components/OperatorSession";
import type {
  CommandEnvelope,
  CommandStatus,
} from "../generated/api";
import { operatorPart, useOperatorSnapshot } from "../hooks/useOperatorSnapshot";
import { useHealthProbe } from "../hooks/useHealthProbe";

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
  const snapshot = useOperatorSnapshot();
  const missions = operatorPart(snapshot, "missions");
  const outbox = operatorPart(snapshot, "outbox");
  const fleet = operatorPart(snapshot, "fleet");
  const sessions = operatorPart(snapshot, "sessions");
  const [command, setCommand] = useState<CommandStatus | null>(null);
  const [phase, setPhase] = useState<MutationPhase>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("acct-local");
  const [model, setModel] = useState("claude-opus-4-6");
  const [provider, setProvider] = useState<CodingProviderName>("claude");
  const [sessionMaterial, setSessionMaterial] = useState(hasSessionMaterial);
  const [historyOpen, setHistoryOpen] = useState(false);
  const runningRef = useRef(false);
  const commandGeneration = useRef(0);
  const health = useHealthProbe();

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
      const payload = pending.envelope.payload as Record<string, unknown>;
      if (pending.kind === "run_coding" && typeof payload.account_id === "string" &&
          typeof payload.model === "string" &&
          typeof payload.provider === "string" &&
          ["claude", "codex", "cursor", "antigravity"].includes(payload.provider)) {
        setAccountId(payload.account_id);
        setModel(payload.model);
        setProvider(payload.provider as CodingProviderName);
      } else if (pending.commandId === null) {
        throw new PendingCommandError("pending command cannot be retried as a coding action; reconcile its original envelope");
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
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        forgetBrowserSession(); setSessionMaterial(false); setHistoryOpen(false);
      }
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
      if (pending?.commandId !== null && pending?.commandId !== undefined) {
        await resumePending();
        return;
      }
      if (pendingCodingConflicts(accountId, provider, model)) {
        throw new PendingCommandError("pending command conflicts with the coding action; reconcile it first");
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
      {snapshot.stream !== undefined && <StatusHeader stream={snapshot.stream} health={health.state} snapshot={snapshot} />}
      <p className="tagline" data-testid="operator-snapshot-provenance">
        source {snapshot.kind === "loading" ? "unknown" : snapshot.source} · observed_at{" "}
        {snapshot.kind === "loading" ? "unknown" : snapshot.observedAt} · event refresh; 10s fallback
      </p>
      <button type="button" onClick={snapshot.refresh}>Refresh snapshot</button>
      <InsightBoard fleet={fleet} sessions={sessions} sessionMaterial={sessionMaterial} />
      <OperatorSession material={sessionMaterial} onChange={(material) => {
        setSessionMaterial(material);
        setHistoryOpen(false);
        if (!material) { commandGeneration.current += 1; runningRef.current = false; }
        snapshot.refresh?.();
      }} />
      <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
        {historyOpen ? "Hide command history" : "Show command history"}
      </button>
      {historyOpen && <CommandHistory onUnauthorized={() => {
        forgetBrowserSession(); setSessionMaterial(false); setHistoryOpen(false);
        commandGeneration.current += 1; runningRef.current = false;
      }} />}
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
