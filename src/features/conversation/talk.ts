import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { CommandEnvelope, CommandStatus } from "../../generated/api";
import { API_PREFIX } from "../../generated/api";
import { ApiError, getCommand, submitCommand } from "../../api";
import { isRfc3339 } from "../../apiValidation";
import { readSnapshot, type SnapshotRead } from "../../apiTransport";
import { canonicalCommandPayload, prepareCommand } from "../../commandIdentity";

export const CONVERSATION_MESSAGE_KIND = "conversation_message";
export const CONVERSATION_MESSAGE_SCHEMA = "bullet.conversation-message.v1";
export const CONVERSATION_RECEIPT_SCHEMA = "bullet.conversation-message-receipt.v1";
export const MAX_MESSAGE_BYTES = 32_768;
export const HEAD_RUNTIME_BINDING_REQUIRED = "HEAD_RUNTIME_BINDING_REQUIRED";
export const SLACK_BIND_UNAVAILABLE =
  "SLACK_BIND_UNAVAILABLE: durable Slack team/channel bind waits for an append-only schema row";
export const TELEGRAM_UNAVAILABLE =
  "TELEGRAM_UNAVAILABLE: no durable Telegram bind; Slack Socket Mode is the inbound door";

const PENDING_SLOT = "bullet-farm.pending-conversation.v1";
const PAGE_LIMIT = 100;
const POLL_MS = 250;
const HEX64 = /^[0-9a-f]{64}$/;
const CONVERSATION_ID = /^cnv_[0-9a-f]{64}$/;
const MESSAGE_ID = /^msg_[0-9a-f]{64}$/;
const HEAD_TURN_ID = /^hdt_[0-9a-f]{64}$/;
const COMMAND_ID = /^cmd_[0-9a-f]{64}$/;
const HEAD_BLOCKER = /^HEAD_[A-Z_]+$/;
const CURSOR_KEYS = ["conversation_id", "message_id", "sequence"] as const;
const MESSAGE_KEYS = [
  "accepted_at",
  "command_id",
  "content",
  "content_digest",
  "cursor",
  "head_turn_id",
  "parent_message_id",
  "role",
] as const;
const VIEW_KEYS = ["cursor", "head_blocker", "messages", "next_after"] as const;
const SUMMARY_KEYS = ["created_at", "cursor", "last_activity_at", "preview"] as const;
const INDEX_KEYS = ["conversations", "next_after"] as const;
const RECEIPT_KEYS = ["content_digest", "cursor", "head_turn_id", "schema_version"] as const;

export type ConversationCursor = {
  conversation_id: string;
  message_id: string;
  sequence: number;
};

export type ConversationMessage = {
  cursor: ConversationCursor;
  parent_message_id: string | null;
  role: "user" | "assistant";
  content: string;
  content_digest: string;
  command_id: string | null;
  head_turn_id: string;
  accepted_at: string;
};

export type ConversationView = {
  cursor: ConversationCursor;
  messages: ConversationMessage[];
  next_after: number | null;
  head_blocker: string;
};

export type ConversationSummary = {
  cursor: ConversationCursor;
  preview: string;
  created_at: string;
  last_activity_at: string;
};

export type ConversationIndexView = {
  conversations: ConversationSummary[];
  next_after: number | null;
};

export type ConversationReceipt = {
  schema_version: typeof CONVERSATION_RECEIPT_SCHEMA;
  cursor: ConversationCursor;
  content_digest: string;
  head_turn_id: string;
};

export type PendingConversation = {
  envelope: CommandEnvelope;
  commandId: string | null;
  payloadDigest: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function digestHex(bytes: string | Uint8Array): string {
  return bytesToHex(blake3(typeof bytes === "string" ? utf8ToBytes(bytes) : bytes));
}

export function validateContent(content: string): string | null {
  if (
    typeof content !== "string" ||
    /[\ud800-\udfff]/u.test(content) ||
    content.trim() === "" ||
    utf8ToBytes(content).length > MAX_MESSAGE_BYTES ||
    [...content].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 || (code >= 0x7f && code <= 0x9f)) && character !== "\n" && character !== "\t";
    })
  ) {
    return "CONVERSATION_MESSAGE_INVALID: content must contain 1..=32768 UTF-8 bytes with only LF/TAB controls";
  }
  return null;
}

export function isConversationCursor(value: unknown): value is ConversationCursor {
  if (!isRecord(value) || !hasExactKeys(value, CURSOR_KEYS)) return false;
  const conversationId = value.conversation_id;
  const messageId = value.message_id;
  const sequence = value.sequence;
  return (
    typeof conversationId === "string" &&
    CONVERSATION_ID.test(conversationId) &&
    typeof messageId === "string" &&
    MESSAGE_ID.test(messageId) &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 1 &&
    sequence <= Number.MAX_SAFE_INTEGER
  );
}

function expectedMessageId(commandId: string): string {
  return `msg_${digestHex(`bullet.conversation-message.v1\0${commandId}`)}`;
}

function expectedHeadTurnId(messageId: string): string {
  return `hdt_${digestHex(`bullet.conversation-head-turn.v1\0${messageId}`)}`;
}

function isCoherentMessage(
  value: unknown,
  threadId: string,
  headBlocker: string,
): value is ConversationMessage {
  if (!isRecord(value) || !hasExactKeys(value, MESSAGE_KEYS) || !isConversationCursor(value.cursor)) {
    return false;
  }
  if (value.cursor.conversation_id !== threadId) return false;
  if (value.role !== "user" && value.role !== "assistant") return false;
  if (typeof value.content !== "string" || validateContent(value.content) !== null) return false;
  if (typeof value.content_digest !== "string" || !HEX64.test(value.content_digest)) return false;
  if (value.content_digest !== digestHex(value.content)) return false;
  const headTurnId = value.head_turn_id;
  const acceptedAt = value.accepted_at;
  const commandId = value.command_id;
  const parentId = value.parent_message_id;
  if (typeof headTurnId !== "string" || !HEAD_TURN_ID.test(headTurnId)) return false;
  if (headTurnId !== expectedHeadTurnId(value.cursor.message_id)) return false;
  if (typeof acceptedAt !== "string" || !isRfc3339(acceptedAt)) return false;
  if (value.role === "user") {
    return (
      typeof commandId === "string" &&
      COMMAND_ID.test(commandId) &&
      value.cursor.message_id === expectedMessageId(commandId) &&
      (parentId === null || (typeof parentId === "string" && MESSAGE_ID.test(parentId)))
    );
  }
  return (
    commandId === null &&
    headBlocker !== HEAD_RUNTIME_BINDING_REQUIRED &&
    (parentId === null || (typeof parentId === "string" && MESSAGE_ID.test(parentId)))
  );
}

export function conversationMessagesCoherent(
  view: ConversationView,
  requestedId: string,
): boolean {
  if (view.cursor.conversation_id !== requestedId) return false;
  const messageIds = new Set<string>();
  const commandIds = new Set<string>();
  const headTurns = new Set<string>();
  let previous: ConversationMessage | undefined;
  for (const message of view.messages) {
    if (message.cursor.conversation_id !== requestedId) return false;
    if (previous === undefined) {
      if (message.cursor.sequence !== 1 || message.parent_message_id !== null) return false;
    } else if (
      message.cursor.sequence !== previous.cursor.sequence + 1 ||
      message.parent_message_id !== previous.cursor.message_id
    ) {
      return false;
    }
    if (messageIds.has(message.cursor.message_id) || headTurns.has(message.head_turn_id)) return false;
    messageIds.add(message.cursor.message_id);
    headTurns.add(message.head_turn_id);
    if (message.command_id !== null) {
      if (commandIds.has(message.command_id)) return false;
      commandIds.add(message.command_id);
    }
    previous = message;
  }
  if (view.next_after !== null) {
    return view.next_after >= 1 && (previous === undefined || view.next_after === previous.cursor.sequence);
  }
  return previous === undefined || previous.cursor.sequence === view.cursor.sequence;
}

export function isConversationView(value: unknown, requestedId?: string): value is ConversationView {
  if (!isRecord(value) || !hasExactKeys(value, VIEW_KEYS) || !isConversationCursor(value.cursor)) {
    return false;
  }
  const headBlocker = value.head_blocker;
  const nextAfter = value.next_after;
  if (typeof headBlocker !== "string" || headBlocker.length > 96 || !HEAD_BLOCKER.test(headBlocker)) {
    return false;
  }
  if (!Array.isArray(value.messages) || value.messages.length > PAGE_LIMIT) return false;
  if (nextAfter !== null && !(typeof nextAfter === "number" && Number.isSafeInteger(nextAfter) && nextAfter >= 1)) {
    return false;
  }
  const threadId = requestedId ?? value.cursor.conversation_id;
  if (!value.messages.every((row) => isCoherentMessage(row, threadId, headBlocker))) return false;
  return conversationMessagesCoherent(value as ConversationView, threadId);
}

function isSummary(value: unknown): value is ConversationSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS) || !isConversationCursor(value.cursor)) {
    return false;
  }
  return (
    typeof value.preview === "string" &&
    utf8ToBytes(value.preview).length <= 80 &&
    isRfc3339(value.created_at) &&
    isRfc3339(value.last_activity_at)
  );
}

export function isConversationIndexView(value: unknown): value is ConversationIndexView {
  if (!isRecord(value) || !hasExactKeys(value, INDEX_KEYS) || !Array.isArray(value.conversations)) {
    return false;
  }
  return (
    value.conversations.length <= PAGE_LIMIT &&
    value.conversations.every(isSummary) &&
    (value.next_after === null ||
      (typeof value.next_after === "number" && Number.isSafeInteger(value.next_after) && value.next_after >= 1))
  );
}

export function isConversationReceipt(value: unknown, content: string): value is ConversationReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS) || !isConversationCursor(value.cursor)) {
    return false;
  }
  return (
    value.schema_version === CONVERSATION_RECEIPT_SCHEMA &&
    typeof value.content_digest === "string" &&
    value.content_digest === digestHex(content) &&
    typeof value.head_turn_id === "string" &&
    value.head_turn_id === expectedHeadTurnId(value.cursor.message_id)
  );
}

export function conversationEnvelope(
  content: string,
  cursor: ConversationCursor | null,
  idempotencyKey?: string,
): CommandEnvelope {
  const error = validateContent(content);
  if (error !== null) throw new Error(error);
  if (cursor !== null && !isConversationCursor(cursor)) {
    throw new Error("CONVERSATION_MESSAGE_INVALID: cursor is not a complete server selector");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const payload = JSON.parse(canonicalCommandPayload({
    schema_version: CONVERSATION_MESSAGE_SCHEMA,
    cursor,
    content,
  })) as CommandEnvelope["payload"];
  return {
    idempotency_key: idempotencyKey ?? `portal_${bytesToHex(bytes)}`,
    kind: CONVERSATION_MESSAGE_KIND,
    payload,
  };
}

function browserStorage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("CONVERSATION_JOURNAL_UNAVAILABLE: pending conversation storage is not a browser Storage");
  }
  return window.sessionStorage;
}

export function loadPendingConversation(): PendingConversation | null {
  const raw = browserStorage().getItem(PENDING_SLOT);
  if (raw === null) return null;
  const record: unknown = JSON.parse(raw);
  if (!isRecord(record) || !isRecord(record.envelope)) {
    throw new Error("CONVERSATION_JOURNAL_INVALID: pending conversation record is unreadable");
  }
  const envelope = record.envelope as CommandEnvelope;
  if (envelope.kind !== CONVERSATION_MESSAGE_KIND) {
    throw new Error("CONVERSATION_JOURNAL_INVALID: pending conversation kind does not match");
  }
  const expected = prepareCommand(envelope).subject;
  if (record.commandId === null || record.commandId === undefined) {
    if (record.payloadDigest !== null && record.payloadDigest !== undefined) {
      throw new Error("CONVERSATION_JOURNAL_INVALID: pending conversation subject is incomplete");
    }
    return { envelope, commandId: null, payloadDigest: null };
  }
  if (record.commandId !== expected.id || record.payloadDigest !== expected.payload_digest) {
    throw new Error("CONVERSATION_JOURNAL_INVALID: pending conversation subject does not match its envelope");
  }
  return { envelope, commandId: expected.id, payloadDigest: expected.payload_digest };
}

export function persistPendingConversation(record: PendingConversation): PendingConversation {
  const prepared = prepareCommand(record.envelope);
  const snapshot: PendingConversation = {
    envelope: JSON.parse(prepared.body) as CommandEnvelope,
    commandId: record.commandId,
    payloadDigest: record.payloadDigest,
  };
  if (snapshot.commandId !== null && (
    snapshot.commandId !== prepared.subject.id || snapshot.payloadDigest !== prepared.subject.payload_digest
  )) {
    throw new Error("CONVERSATION_JOURNAL_INVALID: pending conversation subject does not match its envelope");
  }
  browserStorage().setItem(PENDING_SLOT, JSON.stringify(snapshot));
  return snapshot;
}

export function clearPendingConversation(): void {
  browserStorage().removeItem(PENDING_SLOT);
}

export function envelopeForConversationRetryOrCreate(create: () => CommandEnvelope): CommandEnvelope {
  const pending = loadPendingConversation();
  if (pending !== null) return pending.envelope;
  const envelope = create();
  return persistPendingConversation({ envelope, commandId: null, payloadDigest: null }).envelope;
}

function conversationQuery(after: number | null): string {
  return after === null ? `limit=${PAGE_LIMIT}` : `after=${after}&limit=${PAGE_LIMIT}`;
}

export function listConversations(after: number | null = null): Promise<SnapshotRead<ConversationIndexView>> {
  return readSnapshot(`${API_PREFIX}/conversations?${conversationQuery(after)}`, isConversationIndexView);
}

export async function getConversation(
  id: string,
  after: number | null = null,
): Promise<SnapshotRead<ConversationView>> {
  if (!CONVERSATION_ID.test(id)) {
    throw new Error("CONVERSATION_MESSAGE_INVALID: conversation id is not a server selector");
  }
  const path = `${API_PREFIX}/conversations/${encodeURIComponent(id)}?${conversationQuery(after)}`;
  const page = await readSnapshot(path, (value): value is ConversationView => isConversationView(value, id));
  if (page.data.cursor.conversation_id !== id) {
    throw new ApiError("GET", path, 200, "conversation snapshot does not match its requested subject");
  }
  return page;
}

function payloadContent(envelope: CommandEnvelope): string {
  const payload = envelope.payload as { content?: unknown };
  if (typeof payload.content !== "string") {
    throw new Error("CONVERSATION_MESSAGE_INVALID: journaled payload is missing content");
  }
  return payload.content;
}

async function receiptFromCommand(status: CommandStatus, envelope: CommandEnvelope): Promise<ConversationReceipt> {
  const prepared = prepareCommand(envelope).subject;
  if (status.id !== prepared.id || status.kind !== prepared.kind || status.payload_digest !== prepared.payload_digest) {
    throw new Error("CONVERSATION_RECEIPT_INVALID: command subject does not match the journaled envelope");
  }
  if (status.status === "VERIFIED") {
    throw new Error("CONVERSATION_RECEIPT_INVALID: VERIFIED is not a native Head outcome");
  }
  if (status.status !== "APPLIED") {
    throw new Error(`CONVERSATION_RECEIPT_UNAVAILABLE: command ${status.id} is ${status.status}`);
  }
  if (!isConversationReceipt(status.result, payloadContent(envelope))) {
    throw new Error("CONVERSATION_RECEIPT_INVALID: APPLIED result is not a conversation-message receipt");
  }
  return status.result;
}

async function waitForApplied(initial: CommandStatus, envelope: CommandEnvelope): Promise<ConversationReceipt> {
  let current = initial;
  while (current.status === "PENDING") {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    const next = await getCommand(initial.id);
    if (next.id !== initial.id || next.kind !== initial.kind || next.payload_digest !== initial.payload_digest) {
      throw new Error("CONVERSATION_RECEIPT_INVALID: command reconciliation returned a conflicting subject");
    }
    current = next;
  }
  return receiptFromCommand(current, envelope);
}

function journaledCursor(envelope: CommandEnvelope): ConversationCursor | null {
  const payload = envelope.payload as { cursor?: ConversationCursor | null };
  return payload.cursor ?? null;
}

function sameCursor(left: ConversationCursor | null, right: ConversationCursor | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.conversation_id === right.conversation_id &&
    left.message_id === right.message_id &&
    left.sequence === right.sequence
  );
}

export async function submitConversation(
  content: string,
  cursor: ConversationCursor | null,
): Promise<ConversationReceipt> {
  const pending = loadPendingConversation();
  if (pending !== null && (
    payloadContent(pending.envelope) !== content || !sameCursor(journaledCursor(pending.envelope), cursor)
  )) {
    throw new Error("CONVERSATION_JOURNAL_CONFLICT: reconcile the journaled conversation_message before a new draft");
  }
  if (pending?.commandId !== null && pending?.commandId !== undefined) {
    const admitted = await getCommand(pending.commandId);
    const receipt = await waitForApplied(admitted, pending.envelope);
    clearPendingConversation();
    return receipt;
  }
  const envelope = envelopeForConversationRetryOrCreate(() => conversationEnvelope(content, cursor));
  const admitted = await submitCommand(envelope);
  persistPendingConversation({
    envelope,
    commandId: admitted.id,
    payloadDigest: admitted.payload_digest,
  });
  const receipt = await waitForApplied(admitted, envelope);
  clearPendingConversation();
  return receipt;
}
