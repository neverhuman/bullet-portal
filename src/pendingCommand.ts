import type { CommandEnvelope } from "./generated/api";

const PENDING_SLOT = "bullet-farm.pending-command.v1";

export type PendingCommand = {
  envelope: CommandEnvelope;
  commandId: string | null;
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

export function loadPendingCommand(): PendingCommand | null {
  try {
    const raw = browserStorage()?.getItem(PENDING_SLOT);
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("envelope" in parsed) ||
      !("commandId" in parsed)
    ) {
      return null;
    }
    const record = parsed as PendingCommand;
    const envelope = record.envelope;
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      typeof envelope.idempotency_key !== "string" ||
      envelope.idempotency_key === "" ||
      typeof envelope.kind !== "string" ||
      envelope.kind === "" ||
      typeof envelope.payload !== "object" ||
      envelope.payload === null ||
      (record.commandId !== null && typeof record.commandId !== "string")
    ) {
      return null;
    }
    return {
      envelope: {
        idempotency_key: envelope.idempotency_key,
        kind: envelope.kind,
        payload: envelope.payload,
      },
      commandId: record.commandId,
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
  storage.setItem(PENDING_SLOT, JSON.stringify(record));
}

export function clearPendingCommand(): void {
  try {
    browserStorage()?.removeItem(PENDING_SLOT);
  } catch {
    // Unavailable storage cannot hide an in-memory retry obligation.
  }
}

export function pendingConflicts(next: CommandEnvelope): boolean {
  const pending = loadPendingCommand();
  return pending !== null && envelopeScope(pending.envelope) !== envelopeScope(next);
}

export function envelopeForRetryOrCreate(create: () => CommandEnvelope): CommandEnvelope {
  const pending = loadPendingCommand();
  if (pending !== null) {
    return pending.envelope;
  }
  const envelope = create();
  persistPendingCommand({ envelope, commandId: null });
  return envelope;
}

export function rememberAdmittedCommand(commandId: string): void {
  const pending = loadPendingCommand();
  if (pending === null) {
    return;
  }
  persistPendingCommand({ envelope: pending.envelope, commandId });
}
