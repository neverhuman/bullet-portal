import { expect, it } from "vitest";
import { prepareCommand } from "../../commandIdentity";
import type { CommandStatus, ConversationView } from "../../generated/api";
import { conversationEnvelope, digest, indexValidator, messageId, pageValidator, receiptFor, validateContent } from "./contracts";

const operator = `opr_${"1".repeat(64)}`;
const id = `cnv_${"2".repeat(64)}`;
function message(sequence: number, parent: string | null) {
  const command = `cmd_${sequence.toString(16).padStart(64, "0")}`;
  const mid = messageId(command);
  return { cursor: { conversation_id: id, message_id: mid, sequence }, parent_message_id: parent,
    role: "user" as const, content: "hello", content_digest: digest("hello"), command_id: command,
    head_turn_id: `hdt_${digest(`bullet.conversation-head-turn.v1\0${mid}`)}`, accepted_at: "2026-09-10T00:00:00Z" };
}

it("accepts continuation pages with exact parent and tip instead of requiring sequence one", () => {
  const first = message(1, null); const second = message(2, first.cursor.message_id); const third = message(3, second.cursor.message_id);
  const page: ConversationView = { cursor: third.cursor, messages: [second, third], next_after: null, head_blocker: "HEAD_RUNTIME_BINDING_REQUIRED" };
  expect(pageValidator(id, 1, first.cursor.message_id)(page)).toBe(true);
  for (const changed of [{ ...page, messages: [third, second] }, { ...page, next_after: 2 },
    { ...page, cursor: first.cursor }, { ...page, messages: [{ ...second, parent_message_id: null }, third] },
    { ...page, messages: [second, { ...third, command_id: second.command_id }] }, { ...page, extra: true }]) {
    expect(pageValidator(id, 1, first.cursor.message_id)(changed)).toBe(false);
  }
});

it("rejects forged display rows, nonadvancing pages and unsupported assistant authority", () => {
  const first = message(1, null);
  const page = { cursor: first.cursor, messages: [first], next_after: null, head_blocker: "HEAD_RUNTIME_BINDING_REQUIRED" };
  expect(pageValidator(id)(page)).toBe(true);
  for (const changed of [{ ...first, content: "changed" }, { ...first, role: "assistant", command_id: null },
    { ...first, head_turn_id: `hdt_${"0".repeat(64)}` }, { ...first, cursor: { ...first.cursor, conversation_id: `cnv_${"3".repeat(64)}` } }]) {
    expect(pageValidator(id)({ ...page, messages: [changed] })).toBe(false);
  }
  expect(pageValidator(id)({ ...page, next_after: 1 })).toBe(false);
});

it("binds applied receipts to operator destination, input cursor and original command", () => {
  const envelope = conversationEnvelope("hello", null); const subject = prepareCommand(envelope).subject;
  const mid = messageId(subject.id);
  const receipt = { schema_version: "bullet.conversation-message-receipt.v1", content_digest: digest("hello"),
    cursor: { conversation_id: `cnv_${digest(`bullet.conversation.v1\0${operator}\0${subject.id}`)}`, message_id: mid, sequence: 1 },
    head_turn_id: `hdt_${digest(`bullet.conversation-head-turn.v1\0${mid}`)}` };
  const status: CommandStatus = { ...subject, status: "APPLIED", result: receipt };
  expect(receiptFor(status, envelope, operator)).toEqual(receipt);
  expect(() => receiptFor(status, envelope, `opr_${"3".repeat(64)}`)).toThrow();
  for (const changed of [{ ...receipt, content_digest: digest("other") },
    { ...receipt, cursor: { ...receipt.cursor, sequence: 2 } }, { ...receipt, extra: true }]) {
    expect(() => receiptFor({ ...status, result: changed }, envelope, operator)).toThrow();
  }
  expect(() => receiptFor({ ...status, status: "VERIFIED" }, envelope, operator)).toThrow();
});

it("uses generated Unicode index bounds and refuses duplicate or stuck pagination", () => {
  const row = { cursor: message(1, null).cursor, preview: "界".repeat(80), created_at: "2026-09-10T00:00:00Z", last_activity_at: "2026-09-10T00:00:00Z" };
  expect(indexValidator(0)({ conversations: [row], next_after: 1 })).toBe(true);
  expect(indexValidator(1)({ conversations: [row], next_after: 1 })).toBe(false);
  expect(indexValidator(0)({ conversations: [row, row], next_after: null })).toBe(false);
  expect(validateContent("hello\n\tworld")).toBe(true);
  for (const value of ["  ", "\ud800", "\u0085", "界".repeat(10_923)]) expect(validateContent(value)).toBe(false);
});
