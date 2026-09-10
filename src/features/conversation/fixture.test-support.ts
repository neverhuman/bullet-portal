import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { vi } from "vitest";
import { browserSessionEpoch, csrfToken, rememberCsrfToken } from "../../apiSession";
import { prepareCommand } from "../../commandIdentity";
import type { CommandStatus, ConversationMessageReceipt, ConversationView } from "../../generated/api";
import { digest, messageId, payloadOf } from "./contracts";
import { envelopeOf, type Submission } from "./journal";

export const session = { status: "AUTHENTICATED" as const, operator_id: `opr_${"1".repeat(64)}`,
  session_id: `sid_${"2".repeat(64)}`, issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" };
export const databaseName = "bullet-farm.conversation-submissions.v1";

export function storage() {
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  rememberCsrfToken("synthetic-secret");
  return { origin: window.location.origin, operatorId: session.operator_id, sessionId: session.session_id,
    epoch: browserSessionEpoch(), csrf: csrfToken() };
}

export function applied(row: Submission): CommandStatus & { result: ConversationMessageReceipt } {
  const envelope = envelopeOf(row); const payload = payloadOf(envelope); const mid = messageId(row.id);
  return { ...prepareCommand(envelope).subject, status: "APPLIED", result: {
    schema_version: "bullet.conversation-message-receipt.v1", content_digest: digest(payload.content),
    cursor: { conversation_id: payload.cursor?.conversation_id ?? `cnv_${digest(`bullet.conversation.v1\0${row.operatorId}\0${row.id}`)}`,
      message_id: mid, sequence: (payload.cursor?.sequence ?? 0) + 1 },
    head_turn_id: `hdt_${digest(`bullet.conversation-head-turn.v1\0${mid}`)}`,
  } };
}

export function thread(row: Submission): ConversationView {
  const receipt = applied(row).result; const payload = payloadOf(envelopeOf(row));
  return { cursor: receipt.cursor, next_after: null, head_blocker: "HEAD_RUNTIME_BINDING_REQUIRED", messages: [{
    cursor: receipt.cursor, parent_message_id: payload.cursor?.message_id ?? null, role: "user", content: payload.content,
    content_digest: receipt.content_digest, command_id: row.id, head_turn_id: receipt.head_turn_id,
    accepted_at: session.issued_at,
  }] };
}

export function json(body: unknown, status = 200, sequence = 100): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json",
    "x-bullet-session-id": session.session_id, "x-bullet-as-of-sequence": String(sequence) } });
}
export function snapshot(data: unknown, sequence = 100): Response {
  return json({ data, as_of_sequence: sequence, observed_at: session.issued_at, source: "bullet-kernel/sqlite-ledger" }, 200, sequence);
}

export async function database(version = 3): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      for (const name of version === 1 ? ["submissions", "pending"] : ["submissions", "pending", "drafts", "completed"]) {
        request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function write(db: IDBDatabase, store: string, key: IDBValidKey, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
