import type { CommandEnvelope, CommandStatus } from "../../generated/api";
import { API_PREFIX, PUBLIC_API_RUNTIME_REFS } from "../../generated/api";
import { compileGeneratedValidator, isCommandStatus } from "../../apiValidation";
import { canonicalCommandPayload, prepareCommand } from "../../commandIdentity";
import { assertOwner, type ConversationOwner } from "./owner";

const DATABASE = "bullet-farm.conversation-submissions.v1";
const payloadShape = compileGeneratedValidator(PUBLIC_API_RUNTIME_REFS.ConversationMessagePayload);
const destination = `${API_PREFIX}/commands`;

/** Only immutable request bytes and observed command state are durable here. */
export type Submission = {
  schema: 1;
  origin: string;
  operatorId: string;
  destination: string;
  id: string;
  body: string;
  status: CommandStatus | null;
  refreshed: boolean;
  /** Absent only on records written before the additive version-2 migration. */
  draftRevision?: string;
  /** Later authoritative read, distinct from the original terminal receipt. */
  reconciledStatus?: CommandStatus;
};
export type SubmissionObservation = { origin: string; operatorId: string; commandId: string;
  status: CommandStatus; observedAt: string };
export type ObservationPage = { observations: (SubmissionObservation & { sequence: number })[]; nextAfter: number | null };
export const effectiveStatus = (row: Submission): CommandStatus | null => row.reconciledStatus ?? row.status;
const ownerKey = (owner: ConversationOwner): string[] => [owner.origin, owner.operatorId];
const submissionKey = (row: Submission): string[] => [row.origin, row.operatorId, row.id];
const invalid = (): Error => new Error("CONVERSATION_JOURNAL_INVALID: preserved submission cannot be trusted");

export function envelopeOf(row: Submission): CommandEnvelope {
  const envelope = JSON.parse(row.body) as CommandEnvelope;
  const prepared = prepareCommand(envelope);
  if (envelope.kind !== "conversation_message" || !payloadShape(envelope.payload) ||
      prepared.body !== row.body || prepared.subject.id !== row.id) throw invalid();
  return envelope;
}

function checked(value: unknown, owner: ConversationOwner): Submission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const row = value as Submission;
  if (row.schema !== 1 || row.origin !== owner.origin || row.operatorId !== owner.operatorId ||
      row.destination !== destination || typeof row.body !== "string" || typeof row.refreshed !== "boolean") throw invalid();
  if (row.draftRevision !== undefined && (typeof row.draftRevision !== "string" ||
      row.draftRevision.length === 0 || row.draftRevision.length > 128)) throw invalid();
  const expected = prepareCommand(envelopeOf(row)).subject;
  if (row.status === undefined || row.reconciledStatus === null) throw invalid();
  for (const status of [row.status, row.reconciledStatus]) {
    if (status != null && (!isCommandStatus(status) || status.id !== expected.id ||
        status.kind !== expected.kind || status.payload_digest !== expected.payload_digest)) throw invalid();
  }
  if (row.reconciledStatus !== undefined && (row.status === null || row.status.status === "PENDING")) throw invalid();
  if (row.refreshed && effectiveStatus(row)?.status !== "APPLIED") throw invalid();
  return { ...row, draftRevision: row.draftRevision ?? envelopeOf(row).idempotency_key };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("CONVERSATION_JOURNAL_UNAVAILABLE: this browser cannot preserve submissions")); return;
    }
    const request = indexedDB.open(DATABASE, 3);
    let rejected = false;
    request.onupgradeneeded = () => {
      for (const name of ["submissions", "pending", "drafts", "completed"]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
      if (!request.result.objectStoreNames.contains("observations")) {
        const observations = request.result.createObjectStore("observations", { autoIncrement: true });
        observations.createIndex("submission", ["origin", "operatorId", "commandId"]);
      }
    };
    request.onblocked = () => {
      rejected = true;
      reject(new Error("CONVERSATION_JOURNAL_BLOCKED: close older Bullet tabs and retry"));
    };
    request.onerror = () => reject(new Error("CONVERSATION_JOURNAL_UNAVAILABLE: storage could not open"));
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function transaction<T>(owner: ConversationOwner, mode: IDBTransactionMode,
  action: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  assertOwner(owner);
  const database = await open();
  try {
    assertOwner(owner);
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(["submissions", "pending", "drafts", "completed", "observations"], mode, { durability: "strict" });
      let result: T;
      let failure: unknown;
      const fail = (error: unknown): void => { failure = error; tx.abort(); };
      tx.onabort = () => reject(failure ?? new Error("CONVERSATION_JOURNAL_UNAVAILABLE: transaction aborted"));
      tx.onerror = () => { failure ??= new Error("CONVERSATION_JOURNAL_UNAVAILABLE: storage write failed"); };
      tx.oncomplete = () => resolve(result);
      try { action(tx, (value) => { result = value; }, fail); } catch (error) { fail(error); }
    });
  } finally { database.close(); }
}

function pending(tx: IDBTransaction, owner: ConversationOwner,
  use: (row: Submission | null) => void, fail: (error: unknown) => void, store = "pending"): void {
  const pointer = tx.objectStore(store).get(ownerKey(owner));
  pointer.onsuccess = () => {
    try {
      if (pointer.result === undefined) { use(null); return; }
      if (typeof pointer.result !== "string") throw invalid();
      const request = tx.objectStore("submissions").get([owner.origin, owner.operatorId, pointer.result]);
      request.onsuccess = () => {
        try { use(checked(request.result, owner)); } catch (error) { fail(error); }
      };
    } catch (error) { fail(error); }
  };
}

export async function loadSubmission(owner: ConversationOwner): Promise<Submission | null> {
  const row = await transaction<Submission | null>(owner, "readonly", (tx, done, fail) => pending(tx, owner,
    (active) => active === null ? pending(tx, owner, done, fail, "completed") : done(active), fail));
  assertOwner(owner);
  return row;
}

/** Two tabs contend in one transaction. The winner's exact request always survives. */
export async function reserveSubmission(owner: ConversationOwner, envelope: CommandEnvelope,
  draftRevision = envelope.idempotency_key): Promise<Submission> {
  const prepared = prepareCommand(envelope);
  const proposed = checked({ schema: 1, origin: owner.origin, operatorId: owner.operatorId,
    destination, id: prepared.subject.id, body: prepared.body, status: null, refreshed: false, draftRevision }, owner);
  const row = await transaction<Submission>(owner, "readwrite", (tx, done, fail) => {
    const revision = tx.objectStore("drafts").get([...ownerKey(owner), draftRevision]);
    revision.onsuccess = () => {
      if (revision.result !== undefined) {
        const saved = tx.objectStore("submissions").get([...ownerKey(owner), revision.result]);
        saved.onsuccess = () => {
          try {
            const previous = checked(saved.result, owner);
            if (previous.draftRevision !== draftRevision) throw invalid();
            done(previous);
          } catch (error) { fail(error); }
        };
        return;
      }
      pending(tx, owner, (existing) => {
        assertOwner(owner);
        if (existing !== null) {
          if ((existing.draftRevision ?? envelopeOf(existing).idempotency_key) !== draftRevision) {
            throw new Error("CONVERSATION_JOURNAL_CONFLICT: another draft holds the preserved submission slot");
          }
          const recovered = { ...existing, draftRevision };
          tx.objectStore("submissions").put(recovered, submissionKey(recovered));
          tx.objectStore("drafts").put(recovered.id, [...ownerKey(owner), draftRevision]);
          done(recovered); return;
        }
        const get = tx.objectStore("submissions").get(submissionKey(proposed));
        get.onsuccess = () => {
          try {
            assertOwner(owner);
            if (get.result !== undefined) {
              const saved = checked(get.result, owner);
              if (saved.body !== proposed.body) throw invalid();
              done(saved); return;
            }
            tx.objectStore("submissions").add(proposed, submissionKey(proposed));
            tx.objectStore("pending").add(proposed.id, ownerKey(owner));
            tx.objectStore("drafts").add(proposed.id, [...ownerKey(owner), draftRevision]);
            done(proposed);
          } catch (error) { fail(error); }
        };
      }, fail);
    };
  });
  assertOwner(owner); // A changed owner leaves durable recovery material, but never dispatches it.
  return row;
}

export async function recordStatus(owner: ConversationOwner, original: Submission,
  status: CommandStatus, refreshed = false, reconciliation = false): Promise<Submission> {
  checked({ ...original, status, reconciledStatus: undefined, refreshed }, owner);
  let contradiction = false;
  const row = await transaction<Submission>(owner, "readwrite", (tx, done, fail) => {
    const get = tx.objectStore("submissions").get(submissionKey(original));
    get.onsuccess = () => {
      try {
        assertOwner(owner);
        const stored = checked(get.result, owner);
        if (stored.body !== original.body) throw invalid();
        const previous = effectiveStatus(stored);
        const changed = previous !== null && canonicalCommandPayload(previous) !== canonicalCommandPayload(status);
        contradiction = changed && previous?.status !== "PENDING" &&
          (!reconciliation || previous?.status === "APPLIED" || status.status === "PENDING");
        tx.objectStore("observations").add({ origin: owner.origin, operatorId: owner.operatorId,
          commandId: original.id, status, observedAt: new Date().toISOString() } satisfies SubmissionObservation);
        // Preserve contradictory observations, but never adopt a terminal regression.
        if (contradiction) { done(stored); return; }
        const updated = checked({ ...stored, refreshed: stored.refreshed || refreshed,
          ...(stored.status === null || stored.status.status === "PENDING" ? { status } :
            changed ? { reconciledStatus: status } : {}) }, owner);
        tx.objectStore("submissions").put(updated, submissionKey(updated));
        tx.objectStore("drafts").put(updated.id, [...ownerKey(owner), updated.draftRevision!]);
        if (refreshed) {
          const pointer = tx.objectStore("pending").get(ownerKey(owner));
          pointer.onsuccess = () => {
            if (pointer.result === original.id) {
              // Detach after this commit must still discover the exact completion.
              tx.objectStore("completed").put(original.id, ownerKey(owner));
              tx.objectStore("pending").delete(ownerKey(owner));
            }
          };
        }
        done(updated);
      } catch (error) { fail(error); }
    };
  });
  assertOwner(owner);
  if (contradiction) throw new Error("CONVERSATION_RECEIPT_CONTRADICTION: conflicting observation retained; reconciliation required");
  return row;
}

/** The cursor is an exclusive local observation sequence, never server authority. */
export async function listSubmissionObservationPage(owner: ConversationOwner, row: Submission, after = 0): Promise<ObservationPage> {
  checked(row, owner);
  if (!Number.isSafeInteger(after) || after < 0) throw invalid();
  const page = await transaction<ObservationPage>(owner, "readonly", (tx, done, fail) => {
    const observations: ObservationPage["observations"] = [];
    const get = tx.objectStore("observations").index("submission").openCursor(IDBKeyRange.only(submissionKey(row)));
    get.onsuccess = () => {
      try {
        assertOwner(owner);
        const cursor = get.result;
        if (cursor === null) { done({ observations, nextAfter: null }); return; }
        const sequence = cursor.primaryKey;
        if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) throw invalid();
        if (sequence <= after) { cursor.continuePrimaryKey(submissionKey(row), after + 1); return; }
        if (observations.length === 100) { done({ observations, nextAfter: observations.at(-1)!.sequence }); return; }
        const value: unknown = cursor.value;
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
        const observation = value as SubmissionObservation;
        if (observation.origin !== owner.origin || observation.operatorId !== owner.operatorId || observation.commandId !== row.id ||
            typeof observation.observedAt !== "string" || !Number.isFinite(Date.parse(observation.observedAt))) throw invalid();
        checked({ ...row, status: observation.status, reconciledStatus: undefined, refreshed: false }, owner);
        if (observation.status === null) throw invalid();
        observations.push({ origin: observation.origin, operatorId: observation.operatorId, commandId: observation.commandId,
          status: observation.status, observedAt: observation.observedAt, sequence });
        cursor.continue();
      } catch (error) { fail(error); }
    };
  });
  assertOwner(owner);
  return page;
}

/** Compatibility first page; recovery interfaces use the explicit continuation API. */
export async function listSubmissionObservations(owner: ConversationOwner, row: Submission): Promise<SubmissionObservation[]> {
  return (await listSubmissionObservationPage(owner, row)).observations;
}

/** Explicit acknowledgement frees only this exact terminal slot, retaining unresolved history. */
export async function archiveSubmission(owner: ConversationOwner, original: Submission): Promise<void> {
  await transaction<void>(owner, "readwrite", (tx, done, fail) => pending(tx, owner, (stored) => {
    assertOwner(owner);
    if (stored === null || stored.id !== original.id || stored.body !== original.body ||
        effectiveStatus(stored) === null || !["FAILED", "UNKNOWN"].includes(effectiveStatus(stored)!.status) ||
        canonicalCommandPayload(effectiveStatus(stored)) !== canonicalCommandPayload(effectiveStatus(original))) {
      throw new Error("CONVERSATION_ARCHIVE_REFUSED: refresh the exact terminal submission first");
    }
    tx.objectStore("pending").delete(ownerKey(owner));
    done();
  }, fail));
  assertOwner(owner);
}

/** Paginate preserved requests, including archived unresolved outcomes, within this owner only. */
export async function listSubmissions(owner: ConversationOwner, after?: string): Promise<Submission[]> {
  const rows = await transaction<Submission[]>(owner, "readonly", (tx, done, fail) => {
    const prefix = ownerKey(owner);
    const range = IDBKeyRange.bound(after === undefined ? prefix : [...prefix, after], [...prefix, []], after !== undefined, true);
    const request = tx.objectStore("submissions").getAll(range, 100);
    request.onsuccess = () => {
      try { done(request.result.map((value: unknown) => checked(value, owner))); } catch (error) { fail(error); }
    };
  });
  assertOwner(owner);
  return rows;
}
