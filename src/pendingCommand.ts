import type { CommandEnvelope } from "./generated/api";
import { canonicalCommandPayload, prepareCommand } from "./commandIdentity";
import { getCommand } from "./api";
import { assertOwner, forgetRefusedOwner, ownerHeaders, type ConversationOwner } from "./apiOwner";

const LEGACY_SLOT = "bullet-farm.pending-command.v1";
function pendingSlot(owner: ConversationOwner): string {
  assertOwner(owner);
  return `bullet-farm.pending-command.v2:${JSON.stringify([owner.origin, owner.operatorId])}`;
}
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
  return `${envelope.kind}:${canonicalCommandPayload(envelope.payload)}`;
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
    Object.keys(value).some((key) => !["idempotency_key", "kind", "payload"].includes(key)) ||
    !text(value.idempotency_key) ||
    !text(value.kind) ||
    !isRecord(value.payload)
  ) return null;
  return { idempotency_key: value.idempotency_key, kind: value.kind, payload: value.payload };
}

function parsePending(raw: string): PendingCommand {
    const record: unknown = JSON.parse(raw);
    if (!isRecord(record)) throw new Error("invalid record");
    const envelope = asEnvelope(record.envelope);
    if (envelope === null) throw new Error("invalid envelope");
    const expected = prepareCommand(envelope).subject;
    if (record.commandId === null) {
      // Parsing does not establish ownership or permission to retry.
      if (
        (record.kind !== undefined && record.kind !== envelope.kind) ||
        (record.payloadDigest !== undefined && record.payloadDigest !== null)
      ) throw new Error("invalid pending subject");
      return { envelope, commandId: null, kind: envelope.kind, payloadDigest: null };
    }
    if (
      !text(record.commandId) ||
      record.kind !== envelope.kind ||
      !text(record.payloadDigest) ||
      record.commandId !== expected.id || record.payloadDigest !== expected.payload_digest
    ) throw new Error("incomplete admitted subject");
    return { envelope, commandId: record.commandId, kind: envelope.kind, payloadDigest: record.payloadDigest };
}

function ownedRecord(owner: ConversationOwner): { pending: PendingCommand; raw: string } | null {
  const raw = browserStorage().getItem(pendingSlot(owner));
  if (raw === null) return null;
  const stored: unknown = JSON.parse(raw);
  if (!isRecord(stored) || stored.origin !== owner.origin || stored.operatorId !== owner.operatorId ||
      stored.destination !== "/api/v1/commands") throw new Error("invalid owner");
  const pending = parsePending(raw);
  if (stored.requestBody !== prepareCommand(pending.envelope).body) throw new Error("changed request bytes");
  return { pending, raw };
}

export function loadPendingCommand(owner: ConversationOwner): PendingCommand | null {
  try {
    const owned = ownedRecord(owner);
    if (owned !== null) return owned.pending;
    if (browserStorage().getItem(LEGACY_SLOT) !== null) {
      throw new PendingCommandError("pending command ownership unresolved; reconcile the retained historical request first");
    }
    return null;
  } catch (err) {
    if (err instanceof PendingCommandError) throw err;
    throw new PendingCommandError("pending command storage unreadable or invalid; retained for reconciliation");
  }
}

export function persistPendingCommand(record: PendingCommand, owner: ConversationOwner): PendingCommand {
  return writePending(record, owner);
}

function writePending(record: PendingCommand, owner: ConversationOwner, legacyRaw?: string): PendingCommand {
  try {
    const envelope = asEnvelope(record.envelope);
    if (envelope === null) throw new PendingCommandError("pending command envelope is invalid");
    const prepared = prepareCommand(envelope);
    const expected = prepared.subject;
    const { kind, commandId, payloadDigest } = record;
    if (kind !== expected.kind || (commandId === null
      ? payloadDigest !== null
      : commandId !== expected.id || payloadDigest !== expected.payload_digest)) {
      throw new PendingCommandError("pending command subject does not match its envelope");
    }
    const snapshot: PendingCommand = { envelope: JSON.parse(prepared.body), kind, commandId, payloadDigest };
    const slot = pendingSlot(owner);
    const prior = ownedRecord(owner);
    if (prior !== null && !sameEnvelope(prior.pending.envelope, envelope)) {
      throw new PendingCommandError("pending command conflicts with the retained request");
    }
    if (prior?.pending.commandId != null && commandId === null) {
      throw new PendingCommandError("pending command admission cannot move backwards");
    }
    if (prior === null && legacyRaw === undefined && browserStorage().getItem(LEGACY_SLOT) !== null) {
      throw new PendingCommandError("pending command ownership unresolved; reconcile the retained historical request first");
    }
    const retainedLegacy: unknown = legacyRaw ?? (prior === null ? undefined : JSON.parse(prior.raw).legacyRaw);
    browserStorage().setItem(slot, JSON.stringify({ ...snapshot, origin: owner.origin,
      operatorId: owner.operatorId, destination: "/api/v1/commands", requestBody: prepared.body,
      ...(retainedLegacy === undefined ? {} : { legacyRaw: retainedLegacy }) }));
    return snapshot;
  } catch (err) {
    if (err instanceof PendingCommandError) throw err;
    throw new PendingCommandError("pending command storage write failed; reconciliation required");
  }
}

function clearPendingCommand(owner: ConversationOwner): void {
  try {
    const slot = pendingSlot(owner);
    const retained = ownedRecord(owner);
    if (retained === null) return;
    browserStorage().setItem(`${slot}:history:${prepareCommand(retained.pending.envelope).subject.id}`, retained.raw);
    browserStorage().removeItem(slot);
  } catch {
    throw new PendingCommandError("pending command storage removal failed; reconciliation required");
  }
}

export function clearPendingCommandIf(subject: AdmittedSubject, expected: CommandEnvelope, owner: ConversationOwner): boolean {
  const pending = loadPendingCommand(owner);
  if (
    pending === null ||
    !sameEnvelope(pending.envelope, expected) ||
    pending.commandId !== subject.commandId ||
    pending.kind !== subject.kind ||
    pending.payloadDigest !== subject.payloadDigest
  ) return false;
  clearPendingCommand(owner);
  return true;
}

export function pendingConflicts(next: CommandScope, owner: ConversationOwner): boolean {
  const pending = loadPendingCommand(owner);
  return pending !== null && envelopeScope(pending.envelope) !== envelopeScope(next);
}

export function restoredSubjectConflicts(
  pending: PendingCommand,
  observed: { id: string; kind: string; payload_digest: string },
): boolean {
  return pending.commandId !== observed.id || pending.kind !== observed.kind ||
    pending.payloadDigest === null || pending.payloadDigest !== observed.payload_digest;
}

export function envelopeForRetryOrCreate(create: () => CommandEnvelope, owner: ConversationOwner): CommandEnvelope {
  const pending = loadPendingCommand(owner);
  if (pending !== null) return pending.envelope;
  const envelope = create();
  return persistPendingCommand({ envelope, commandId: null, kind: envelope.kind, payloadDigest: null }, owner).envelope;
}

export function rememberAdmittedCommand(subject: AdmittedSubject, expected: CommandEnvelope, owner: ConversationOwner): boolean {
  const pending = loadPendingCommand(owner);
  const derived = prepareCommand(expected).subject;
  if (
    pending === null ||
    !sameEnvelope(pending.envelope, expected) ||
    subject.kind !== expected.kind ||
    subject.commandId !== derived.id || subject.payloadDigest !== derived.payload_digest ||
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
    }, owner);
    return true;
  } catch {
    return false;
  }
}

/** Legacy bytes are private until an authenticated owner-filtered exact read succeeds. */
export async function recoverPendingCommand(owner: ConversationOwner, signal?: AbortSignal): Promise<PendingCommand | null> {
  try {
    const owned = ownedRecord(owner);
    if (owned !== null) return owned.pending;
    const raw = browserStorage().getItem(LEGACY_SLOT);
    if (raw === null) return null;
    const pending = parsePending(raw);
    const expected = prepareCommand(pending.envelope).subject;
    const observed = await getCommand(expected.id, signal, ownerHeaders(owner));
    assertOwner(owner, signal);
    if (observed.id !== expected.id || observed.kind !== expected.kind || observed.payload_digest !== expected.payload_digest ||
        browserStorage().getItem(LEGACY_SLOT) !== raw) throw new Error("historical subject changed");
    const adopted = writePending({ envelope: pending.envelope, commandId: observed.id,
      kind: observed.kind, payloadDigest: observed.payload_digest }, owner, raw);
    // The committed owner-scoped record retains the exact original bytes before removal.
    browserStorage().removeItem(LEGACY_SLOT);
    return adopted;
  } catch (error) {
    forgetRefusedOwner(owner, error);
    throw new PendingCommandError("pending command ownership unresolved; historical bytes retained for reconciliation");
  }
}
