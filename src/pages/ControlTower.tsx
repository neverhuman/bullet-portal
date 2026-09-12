import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  errorText,
  getCommand,
  hasSessionMaterial,
  newRunCodingEnvelope,
  type CodingProviderName,
  type RunCodingFields,
  submitCommand,
} from "../api";
import {
  clearPendingCommandIf,
  envelopeForRetryOrCreate,
  loadPendingCommand,
  recoverPendingCommand,
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
import { CodingTaskFields, emptyCodingTask } from "../components/CodingTaskFields";
import { CodingTaskCard } from "../components/CodingTaskCard";
import { codingTaskPayload, isCodingTaskPayload } from "../codingTasks";
import { canonicalCommandPayload, prepareCommand } from "../commandIdentity";
import type {
  CommandEnvelope,
  CommandStatus,
} from "../generated/api";
import { operatorPart, useOperatorSnapshot } from "../hooks/useOperatorSnapshot";
import { useHealthProbe } from "../hooks/useHealthProbe";
import { onBrowserSessionChange } from "../apiSession";
import { assertOwner, discoverOwner, forgetRefusedOwner, ownerHeaders, type ConversationOwner } from "../apiOwner";

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

function pendingCodingConflicts(fields: RunCodingFields, owner: ConversationOwner): boolean {
  const pending = loadPendingCommand(owner);
  if (pending === null) return false;
  if (pending.envelope.kind !== "run_coding") return true;
  const payload = pending.envelope.payload as Record<string, unknown>;
  if (isCodingTaskPayload(payload)) {
    return canonicalCommandPayload(payload) !== canonicalCommandPayload(codingTaskPayload(fields));
  }
  if ("schema_version" in payload) return true;
  // Historical exact retries retain their original authority-bearing bytes.
  // This branch never constructs a new legacy submission.
  return (
    payload.account_id !== fields.accountId ||
    payload.provider !== fields.provider ||
    payload.model !== fields.model
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
  const [task, setTask] = useState(emptyCodingTask);
  const [effort, setEffort] = useState("");
  const [taskCommand, setTaskCommand] = useState(false);
  const [legacyRetry, setLegacyRetry] = useState(false);
  const [sessionMaterial, setSessionMaterial] = useState(hasSessionMaterial);
  const [historyOpen, setHistoryOpen] = useState(false);
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  const commandGeneration = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const health = useHealthProbe();

  async function reconcile(initial: CommandStatus, generation: number, envelope: CommandEnvelope, owner: ConversationOwner, signal: AbortSignal): Promise<void> {
    let last = initial;
    while (!isTerminal(last.status)) {
      await waitForPoll();
      if (commandGeneration.current !== generation) {
        return;
      }
      let next: CommandStatus;
      try {
        next = await getCommand(initial.id, signal, ownerHeaders(owner));
        assertOwner(owner, signal);
      } catch (err) {
        if (commandGeneration.current === generation) {
          forgetRefusedOwner(owner, err);
          if (commandGeneration.current !== generation) return;
          setPhase("UNKNOWN");
          setError(`command ${initial.id} reconciliation unknown (${errorText(err)})`);
          runningRef.current = false; setRunning(false);
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
        runningRef.current = false; setRunning(false);
        return;
      }
      if (next.status === "VERIFIED") {
        setCommand(next);
        setPhase("UNKNOWN");
        setError(unverifiableSuccess(next.id));
        runningRef.current = false; setRunning(false);
        if (commandGeneration.current === generation) {
          if (clearPendingCommandIf({
            commandId: next.id,
            kind: next.kind,
            payloadDigest: next.payload_digest,
          }, envelope, owner)) setLegacyRetry(false);
        }
        return;
      }
      last = next;
      setCommand(next);
      setPhase(next.status);
    }
    runningRef.current = false; setRunning(false);
    if (commandGeneration.current === generation) {
      if (clearPendingCommandIf({
        commandId: last.id,
        kind: last.kind,
        payloadDigest: last.payload_digest,
      }, envelope, owner)) setLegacyRetry(false);
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
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const signal = active.signal;
    let owner: ConversationOwner | null = null;
    runningRef.current = true; setRunning(true);
    try {
      owner = await discoverOwner(signal);
      const pending = await recoverPendingCommand(owner, signal);
      assertOwner(owner, signal);
      if (commandGeneration.current !== generation) return;
      if (pending === null) return;
      const payload = pending.envelope.payload as Record<string, unknown>;
      if (pending.kind === "run_coding" && isCodingTaskPayload(payload)) {
        setTask(payload.task);
        setAccountId(payload.selection.account_id);
        setModel(payload.selection.model);
        setProvider(payload.selection.provider);
        setEffort(payload.selection.effort ?? "");
        setTaskCommand(true);
        setLegacyRetry(false);
      } else if (pending.kind === "run_coding" && !("schema_version" in payload) && typeof payload.account_id === "string" &&
          typeof payload.model === "string" &&
          typeof payload.provider === "string" &&
          ["claude", "codex", "cursor", "antigravity"].includes(payload.provider)) {
        setAccountId(payload.account_id);
        setModel(payload.model);
        setProvider(payload.provider as CodingProviderName);
        setTaskCommand(false);
        setLegacyRetry(true);
      } else if (pending.commandId === null) {
        throw new PendingCommandError("pending command cannot be retried as a coding action; reconcile its original envelope");
      }
      if (pending.commandId === null) return;
      runningRef.current = true; setRunning(true);
      setPhase("PENDING");
      setError(null);
      const admitted = await getCommand(pending.commandId, signal, ownerHeaders(owner));
      assertOwner(owner, signal);
      if (commandGeneration.current !== generation) return;
      if (restoredSubjectConflicts(pending, admitted)) {
        throw new PendingCommandError(
          `command ${pending.commandId} restored subject conflicts with persisted kind or digest`,
        );
      }
      setCommand(admitted);
      await reconcile(admitted, generation, pending.envelope, owner, signal);
    } catch (err) {
      if (commandGeneration.current !== generation) return;
      if (owner !== null) forgetRefusedOwner(owner, err);
      if (commandGeneration.current !== generation) return;
      setPhase("UNKNOWN");
      setError(`command reconciliation unknown (${errorText(err)})`);
    } finally {
      if (commandGeneration.current === generation) { runningRef.current = false; setRunning(false); }
    }
  }

  useEffect(() => {
    const unsubscribe = onBrowserSessionChange(() => {
      commandGeneration.current += 1;
      controller.current?.abort();
      runningRef.current = false; setRunning(false);
      setCommand(null);
      setPhase("IDLE");
      setError(null);
      setHistoryOpen(false);
      setTask(emptyCodingTask());
      setAccountId("acct-local");
      setModel("claude-opus-4-6");
      setProvider("claude");
      setEffort("");
      setTaskCommand(false);
      setLegacyRetry(false);
      setSessionMaterial(hasSessionMaterial());
      if (hasSessionMaterial()) {
        const generation = commandGeneration.current;
        queueMicrotask(() => { if (commandGeneration.current === generation) void resumePending(); });
      }
    });
    void resumePending();
    return () => {
      unsubscribe();
      commandGeneration.current += 1;
      controller.current?.abort();
      runningRef.current = false; setRunning(false);
    };
  }, []);

  async function onRunCoding(): Promise<void> {
    if (runningRef.current) return;
    const generation = ++commandGeneration.current;
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const signal = active.signal;
    let owner: ConversationOwner | null = null;
    runningRef.current = true; setRunning(true);
    setPhase("PENDING"); setError(null); setCommand(null);
    try {
      owner = await discoverOwner(signal);
      const pending = await recoverPendingCommand(owner, signal);
      assertOwner(owner, signal);
      if (commandGeneration.current !== generation) return;
      const fields: RunCodingFields = { task, accountId, provider, model, effort: effort === "" ? null : effort };
      if (pendingCodingConflicts(fields, owner)) {
        throw new PendingCommandError("pending command conflicts with the coding action; reconcile it first");
      }
      const envelope = envelopeForRetryOrCreate(() => newRunCodingEnvelope(fields), owner);
      setTaskCommand(isCodingTaskPayload(envelope.payload));
      let admitted: CommandStatus | null = null;
      if (pending !== null) {
        const expected = prepareCommand(envelope).subject;
        try {
          admitted = await getCommand(expected.id, signal, ownerHeaders(owner));
          if (admitted.id !== expected.id || admitted.kind !== expected.kind || admitted.payload_digest !== expected.payload_digest) {
            throw new PendingCommandError("restored command subject conflicts with its exact request");
          }
        } catch (err) {
          if (!(pending.commandId === null && err instanceof ApiError && err.status === 404 &&
              err.code === "NOT_FOUND" && err.acknowledgedSession === owner.sessionId)) throw err;
        }
      }
      assertOwner(owner, signal);
      if (admitted === null) {
        if (owner.csrf === null) throw new PendingCommandError("authenticate before submitting a command");
        admitted = await submitCommand(envelope, { signal, csrf: owner.csrf });
      }
      assertOwner(owner, signal);
      if (commandGeneration.current !== generation) return;
      setCommand(admitted);
      const persisted = rememberAdmittedCommand({ commandId: admitted.id, kind: admitted.kind,
        payloadDigest: admitted.payload_digest }, envelope, owner);
      if (!persisted) {
        throw new PendingCommandError(`command ${admitted.id} admitted but persistence failed; retry will reuse the envelope`);
      }
      await reconcile(admitted, generation, envelope, owner, signal);
    } catch (err) {
      if (commandGeneration.current !== generation) return;
      if (owner !== null) forgetRefusedOwner(owner, err);
      if (commandGeneration.current !== generation) return;
      const ambiguous = err instanceof ApiError && err.outcomeUnknown;
      setPhase(ambiguous || err instanceof PendingCommandError ? "UNKNOWN" : "FAILED");
      setError(ambiguous ? `command admission outcome unknown; no command id was received (${errorText(err)})` : errorText(err));
    } finally {
      if (commandGeneration.current === generation) { runningRef.current = false; setRunning(false); }
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
        if (!material) { commandGeneration.current += 1; runningRef.current = false; setRunning(false); }
        snapshot.refresh?.();
      }} />
      <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
        {historyOpen ? "Hide command history" : "Show command history"}
      </button>
      {historyOpen && <CommandHistory onUnauthorized={() => {
        setSessionMaterial(hasSessionMaterial()); setHistoryOpen(false);
        commandGeneration.current += 1; runningRef.current = false; setRunning(false);
      }} />}
      <details open>
      <summary>Advanced coding task</summary>
      {legacyRetry ? <p>Saved historical request: retry uses its exact original contents.</p> :
        <CodingTaskFields value={task} onChange={setTask} disabled={running} />}
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
      <label htmlFor="coding-effort">Effort (optional)</label>{" "}
      <input id="coding-effort" value={effort} disabled={legacyRetry}
        onChange={(event) => setEffort(event.target.value)} />{" "}
      <button
        type="button"
        disabled={!sessionMaterial || running}
        onClick={() => void onRunCoding()}
      >
        Submit durable coding command
      </button>
      </details>
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
      {command !== null && taskCommand ? <CodingTaskCard commandId={command.id} /> : null}
    </main>
  );
}
