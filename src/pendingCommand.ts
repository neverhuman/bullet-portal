import type { CommandEnvelope } from "./generated/api";

const PENDING_SLOT = "bullet-farm.pending-command.v1";

export type PendingCommand = {
  envelope: CommandEnvelope;
  commandId: string | null;
  kind: string | null;
  payloadDigest: string | null;
};

export type AdmittedSubject = {
  commandId: string;
  kind: string;
  payloadDigest: string;
};

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function envelopeScope(envelope: CommandEnvelope): string {
  return `${envelope.kind}:${JSON.stringify(envelope.payload)}`;
}

function asEnvelope(value: unknown): CommandEnvelope | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const envelope = value as CommandEnvelope;
  if (
    typeof envelope.idempotency_key !== "string" ||
    envelope.idempotency_key === "" ||
    typeof envelope.kind !== "string" ||
    envelope.kind === "" ||
    typeof envelope.payload !== "object" ||
    envelope.payload === null
  ) {
    return null;
  }
  return {
    idempotency_key: envelope.idempotency_key,
    kind: envelope.kind,
    payload: envelope.payload,
  };
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" && value !== "" ? value : null;
}

export function loadPendingCommand(): PendingCommand | null {
  try {
    const raw = browserStorage()?.getItem(PENDING_SLOT);
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("envelope" in parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const envelope = asEnvelope(record.envelope);
    if (envelope === null) {
      return null;
    }
    const commandId = optionalText(record.commandId);
    return {
      envelope,
      commandId,
      kind: optionalText(record.kind),
      payloadDigest: optionalText(record.payloadDigest),
    };
  } catch {
    return null;
  }
}

export function persistPendingCommand(record: PendingCommand): void {
  const storage = browserStorage();
  if (storage === null) {
    throw new Error("pending command storage unavailable");
  }
  storage.setItem(
    PENDING_SLOT,
    JSON.stringify({
      envelope: record.envelope,
      commandId: record.commandId,
      kind: record.kind,
      payloadDigest: record.payloadDigest,
    }),
  );
}

export function clearPendingCommand(): void {
  try {
    browserStorage()?.removeItem(PENDING_SLOT);
  } catch {
    // Unavailable storage cannot hide an in-memory retry obligation.
  }
}

export function clearPendingCommandIf(subject: AdmittedSubject): boolean {
  const pending = loadPendingCommand();
  if (
    pending === null ||
    pending.commandId !== subject.commandId ||
    (pending.kind !== null && pending.kind !== subject.kind) ||
    (pending.payloadDigest !== null && pending.payloadDigest !== subject.payloadDigest)
  ) {
    return false;
  }
  clearPendingCommand();
  return true;
}

export function pendingConflicts(next: CommandEnvelope): boolean {
  const pending = loadPendingCommand();
  return pending !== null && envelopeScope(pending.envelope) !== envelopeScope(next);
}

export function restoredSubjectConflicts(
  pending: PendingCommand,
  observed: { id: string; kind: string; payload_digest: string },
): boolean {
  if (pending.commandId !== null && pending.commandId !== observed.id) {
    return true;
  }
  if (pending.kind !== null && pending.kind !== observed.kind) {
    return true;
  }
  if (pending.payloadDigest !== null && pending.payloadDigest !== observed.payload_digest) {
    return true;
  }
  return false;
}

export function envelopeForRetryOrCreate(create: () => CommandEnvelope): CommandEnvelope {
  const pending = loadPendingCommand();
  if (pending !== null) {
    return pending.envelope;
  }
  const envelope = create();
  persistPendingCommand({
    envelope,
    commandId: null,
    kind: envelope.kind,
    payloadDigest: null,
  });
  return envelope;
}

export function rememberAdmittedCommand(subject: AdmittedSubject): boolean {
  const pending = loadPendingCommand();
  if (pending === null) {
    return false;
  }
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
