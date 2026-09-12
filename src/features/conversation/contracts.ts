import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { PUBLIC_API_RUNTIME_REFS } from "../../generated/api";
import type { CommandEnvelope, CommandStatus, ConversationCursor, ConversationIndexView,
  ConversationMessagePayload, ConversationMessageReceipt, ConversationView } from "../../generated/api";
import { compileGeneratedValidator } from "../../apiValidation";
import { prepareCommand } from "../../commandIdentity";

export type { ConversationCursor, ConversationIndexView, ConversationMessageReceipt, ConversationView } from "../../generated/api";
export const PAGE_LIMIT = 100;
export const digest = (text: string): string => bytesToHex(blake3(utf8ToBytes(text)));
export const messageId = (commandId: string): string => `msg_${digest(`bullet.conversation-message.v1\0${commandId}`)}`;
const headId = (id: string): string => `hdt_${digest(`bullet.conversation-head-turn.v1\0${id}`)}`;
const payloadShape = compileGeneratedValidator<ConversationMessagePayload>(PUBLIC_API_RUNTIME_REFS.ConversationMessagePayload);
const receiptShape = compileGeneratedValidator<ConversationMessageReceipt>(PUBLIC_API_RUNTIME_REFS.ConversationMessageReceipt);
const viewShape = compileGeneratedValidator<ConversationView>(PUBLIC_API_RUNTIME_REFS.ConversationView);
const indexShape = compileGeneratedValidator<ConversationIndexView>(PUBLIC_API_RUNTIME_REFS.ConversationIndexView);

export function validateContent(content: string): boolean {
  return content.trim() !== "" && utf8ToBytes(content).length <= 32_768 &&
    !/[\ud800-\udfff]/u.test(content) && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(content);
}

export function payloadOf(envelope: CommandEnvelope): ConversationMessagePayload {
  if (envelope.kind !== "conversation_message" || !payloadShape(envelope.payload) ||
      !validateContent(envelope.payload.content)) throw new Error("CONVERSATION_MESSAGE_INVALID: enter valid message text");
  return envelope.payload;
}

export function conversationEnvelope(content: string, cursor: ConversationCursor | null): CommandEnvelope {
  const envelope: CommandEnvelope = { idempotency_key: `portal_${crypto.randomUUID()}`,
    kind: "conversation_message", payload: { schema_version: "bullet.conversation-message.v1", content, cursor } };
  payloadOf(envelope);
  return envelope;
}

export function indexValidator(after: number): (value: unknown) => value is ConversationIndexView {
  return (value): value is ConversationIndexView => indexShape(value) &&
    new Set(value.conversations.map((row) => row.cursor.conversation_id)).size === value.conversations.length &&
    (value.next_after === null || value.conversations.length > 0 && value.next_after > after);
}

export function pageValidator(id: string, after = 0, parent?: string): (value: unknown) => value is ConversationView {
  return (value): value is ConversationView => {
    if (!viewShape(value) || value.cursor.conversation_id !== id || value.cursor.sequence < after) return false;
    let sequence = after;
    let previous = parent;
    const commands = new Set<string>();
    for (const row of value.messages) {
      // Schema-27 has no native assistant outcome. Do not infer one from display text.
      if (row.role !== "user" || row.command_id === null || !validateContent(row.content) ||
          row.cursor.conversation_id !== id || row.cursor.sequence !== sequence + 1 ||
          row.cursor.message_id !== messageId(row.command_id) || row.head_turn_id !== headId(row.cursor.message_id) ||
          row.content_digest !== digest(row.content) || commands.has(row.command_id) ||
          (sequence === 0 ? row.parent_message_id !== null :
            previous === undefined ? row.parent_message_id === null : row.parent_message_id !== previous)) return false;
      commands.add(row.command_id);
      sequence = row.cursor.sequence;
      previous = row.cursor.message_id;
    }
    if (sequence > value.cursor.sequence) return false;
    if (value.next_after !== null) {
      return value.messages.length > 0 && value.next_after === sequence && sequence < value.cursor.sequence;
    }
    return sequence === value.cursor.sequence && (previous === undefined || previous === value.cursor.message_id);
  };
}

export function receiptFor(status: CommandStatus, envelope: CommandEnvelope, operator: string): ConversationMessageReceipt {
  const expected = prepareCommand(envelope).subject;
  const payload = payloadOf(envelope);
  const receipt = status.result;
  const id = messageId(expected.id);
  const conversation = payload.cursor?.conversation_id ?? `cnv_${digest(`bullet.conversation.v1\0${operator}\0${expected.id}`)}`;
  if (status.id !== expected.id || status.kind !== expected.kind || status.payload_digest !== expected.payload_digest ||
      status.status !== "APPLIED" || !receiptShape(receipt) || receipt.content_digest !== digest(payload.content) ||
      receipt.cursor.conversation_id !== conversation || receipt.cursor.message_id !== id ||
      receipt.cursor.sequence !== (payload.cursor?.sequence ?? 0) + 1 || receipt.head_turn_id !== headId(id)) {
    throw new Error(`CONVERSATION_RECEIPT_UNAVAILABLE: saved command is ${status.status}; preserve and reconcile it`);
  }
  return receipt;
}

export function confirmsReceipt(view: ConversationView, receipt: ConversationMessageReceipt, commandId: string): boolean {
  return view.cursor.conversation_id === receipt.cursor.conversation_id &&
    view.messages.some((message) => message.cursor.message_id === receipt.cursor.message_id &&
      message.cursor.sequence === receipt.cursor.sequence && message.content_digest === receipt.content_digest &&
      message.command_id === commandId && message.head_turn_id === receipt.head_turn_id);
}
