import type { CommandEnvelope } from "./generated/api";

const PENDING_SLOT = "bullet-farm.pending-command.v1";
type CommandScope = Pick<CommandEnvelope, "kind" | "payload">;

export type PendingCommand = {
  envelope: CommandEnvelope;
  commandId: string | null;
  kind: string;
  payloadDigest: string | null;
};

export type AdmittedSubject = {
  commandId: string;
  kind: string;
  payloadDigest: string;
};

export class PendingCommandError extends Error {}

function browserStorage(): Storage {
  try {
    if (typeof window !== "undefined") return window.sessionStorage;
  } catch {
    // The retained slot is not known to be empty when storage is unavailable.
  }
  throw new PendingCommandError("pending command storage unavailable; reconciliation required");
}

function envelopeScope(envelope: CommandScope): string {
  return `${envelope.kind}:${JSON.stringify(envelope.payload)}`;
}

function sameEnvelope(left: CommandEnvelope, right: CommandEnvelope): boolean {
  return left.idempotency_key === right.idempotency_key && envelopeScope(left) === envelopeScope(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function asEnvelope(value: unknown): CommandEnvelope | null {
  if (
    !isRecord(value) ||
    !text(value.idempotency_key) ||
    !text(value.kind) ||
    !isRecord(value.payload)
  ) return null;
  return { idempotency_key: value.idempotency_key, kind: value.kind, payload: value.payload };
}

export function loadPendingCommand(): PendingCommand | null {
  try {
    const raw = browserStorage().getItem(PENDING_SLOT);
    if (raw === null) return null;
    const record: unknown = JSON.parse(raw);
    if (!isRecord(record)) throw new Error("invalid record");
    const envelope = asEnvelope(record.envelope);
    if (envelope === null) throw new Error("invalid envelope");
    if (record.commandId === null) {
      // The original envelope-only format is a safe same-key retry, not an admission.
      if (
        (record.kind !== undefined && record.kind !== envelope.kind) ||
        (record.payloadDigest !== undefined && record.payloadDigest !== null)
      ) throw new Error("invalid pending subject");
      return { envelope, commandId: null, kind: envelope.kind, payloadDigest: null };
    }
    if (
      !text(record.commandId) ||
      record.kind !== envelope.kind ||
      !text(record.payloadDigest)
    ) throw new Error("incomplete admitted subject");
    return { envelope, commandId: record.commandId, kind: envelope.kind, payloadDigest: record.payloadDigest };
  } catch (err) {
    if (err instanceof PendingCommandError) throw err;
    throw new PendingCommandError("pending command storage unreadable or invalid; retained for reconciliation");
  }
}

export function persistPendingCommand(record: PendingCommand): void {
  try {
    browserStorage().setItem(PENDING_SLOT, JSON.stringify(record));
  } catch {
    throw new PendingCommandError("pending command storage write failed; reconciliation required");
  }
}

export function clearPendingCommand(): void {
  try {
    browserStorage().removeItem(PENDING_SLOT);
  } catch {
    throw new PendingCommandError("pending command storage removal failed; reconciliation required");
  }
}

export function clearPendingCommandIf(subject: AdmittedSubject, expected: CommandEnvelope): boolean {
  const pending = loadPendingCommand();
  if (
    pending === null ||
    !sameEnvelope(pending.envelope, expected) ||
    pending.commandId !== subject.commandId ||
    pending.kind !== subject.kind ||
    pending.payloadDigest !== subject.payloadDigest
  ) return false;
  clearPendingCommand();
  return true;
}

export function pendingConflicts(next: CommandScope): boolean {
  const pending = loadPendingCommand();
  return pending !== null && envelopeScope(pending.envelope) !== envelopeScope(next);
}

export function restoredSubjectConflicts(
  pending: PendingCommand,
  observed: { id: string; kind: string; payload_digest: string },
): boolean {
  return pending.commandId !== observed.id || pending.kind !== observed.kind ||
    pending.payloadDigest === null || pending.payloadDigest !== observed.payload_digest;
}

export function envelopeForRetryOrCreate(create: () => CommandEnvelope): CommandEnvelope {
  const pending = loadPendingCommand();
  if (pending !== null) return pending.envelope;
  const envelope = create();
  persistPendingCommand({ envelope, commandId: null, kind: envelope.kind, payloadDigest: null });
  return envelope;
}

export function rememberAdmittedCommand(subject: AdmittedSubject, expected: CommandEnvelope): boolean {
  const pending = loadPendingCommand();
  if (
    pending === null ||
    !sameEnvelope(pending.envelope, expected) ||
    subject.kind !== expected.kind ||
    (pending.commandId !== null && restoredSubjectConflicts(pending, {
      id: subject.commandId, kind: subject.kind, payload_digest: subject.payloadDigest,
    }))
  ) return false;
  try {
    persistPendingCommand({
      envelope: pending.envelope,
      commandId: subject.commandId,
      kind: subject.kind,
      payloadDigest: subject.payloadDigest,
    });
    return true;
  } catch {
    return false;
  }
}
