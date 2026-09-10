import { ApiError, getCommand, submitCommand } from "../../api";
import { API_PREFIX } from "../../generated/api";
import { readSnapshot, type SnapshotRead } from "../../apiTransport";
import { canonicalCommandPayload } from "../../commandIdentity";
import { assertOwner, forgetRefusedOwner, ownerHeaders, verifyOwner, type ConversationOwner } from "./owner";
import { effectiveStatus, envelopeOf, recordStatus, reserveSubmission, type Submission } from "./journal";
import { confirmsReceipt, conversationEnvelope, indexValidator, pageValidator, PAGE_LIMIT, payloadOf, receiptFor,
  type ConversationCursor, type ConversationIndexView, type ConversationView } from "./contracts";

export { payloadOf } from "./contracts";
export type { ConversationCursor, ConversationIndexView, ConversationView } from "./contracts";

export async function listConversations(owner: ConversationOwner, after = 0, signal?: AbortSignal): Promise<SnapshotRead<ConversationIndexView>> {
  assertOwner(owner, signal);
  const page = await readSnapshot(`${API_PREFIX}/conversations?after=${after}&limit=${PAGE_LIMIT}`,
    indexValidator(after), signal, ownerHeaders(owner)).catch((error: unknown) => {
      forgetRefusedOwner(owner, error); throw error;
    });
  assertOwner(owner, signal);
  if (page.data.next_after !== null && page.data.next_after > page.asOfSequence) {
    throw new Error("CONVERSATION_INDEX_INVALID: continuation exceeds snapshot watermark");
  }
  return page;
}

export async function readConversationIndexWindow(owner: ConversationOwner, visible = PAGE_LIMIT,
  signal?: AbortSignal): Promise<SnapshotRead<ConversationIndexView>> {
  let page = await listConversations(owner, 0, signal);
  const conversations = [...page.data.conversations];
  const known = new Set(conversations.map((row) => row.cursor.conversation_id));
  while (page.data.next_after !== null && conversations.length < visible) {
    const next = await listConversations(owner, page.data.next_after, signal);
    if (next.asOfSequence < page.asOfSequence || next.data.conversations.some((row) => known.has(row.cursor.conversation_id))) {
      throw new Error("CONVERSATION_INDEX_CHANGED: refresh your thread list");
    }
    for (const row of next.data.conversations) known.add(row.cursor.conversation_id);
    conversations.push(...next.data.conversations); page = next;
  }
  return { ...page, data: { ...page.data, conversations } };
}

export async function getConversation(owner: ConversationOwner, id: string, after = 0,
  parent?: string, signal?: AbortSignal): Promise<SnapshotRead<ConversationView>> {
  assertOwner(owner, signal);
  if (!/^cnv_[0-9a-f]{64}$/.test(id)) throw new Error("CONVERSATION_MESSAGE_INVALID: invalid thread");
  const page = await readSnapshot(`${API_PREFIX}/conversations/${id}?after=${after}&limit=${PAGE_LIMIT}`,
    pageValidator(id, after, parent), signal, ownerHeaders(owner)).catch((error: unknown) => {
      forgetRefusedOwner(owner, error); throw error;
    });
  assertOwner(owner, signal);
  return page;
}

export async function readConversationWindow(owner: ConversationOwner, id: string,
  visibleMessages = PAGE_LIMIT, signal?: AbortSignal): Promise<SnapshotRead<ConversationView>> {
  let page = await getConversation(owner, id, 0, undefined, signal);
  const messages = [...page.data.messages];
  const commands = new Set(messages.map((row) => row.command_id));
  while (page.data.next_after !== null && messages.length < visibleMessages) {
    const next = await getConversation(owner, id, page.data.next_after, messages.at(-1)?.cursor.message_id, signal);
    if (next.asOfSequence < page.asOfSequence || next.data.cursor.sequence < page.data.cursor.sequence ||
        next.data.messages.some((row) => commands.has(row.command_id))) {
      throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: refresh the conversation");
    }
    for (const row of next.data.messages) commands.add(row.command_id);
    messages.push(...next.data.messages);
    page = next;
  }
  return { ...page, data: { ...page.data, messages } };
}

function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("CONVERSATION_REQUEST_CANCELED")); return; }
    const cancel = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new Error("CONVERSATION_REQUEST_CANCELED")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 250);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function reconcileSubmission(owner: ConversationOwner, original: Submission,
  signal?: AbortSignal, visibleMessages = PAGE_LIMIT): Promise<{ submission: Submission; thread: SnapshotRead<ConversationView> }> {
  if (original.origin !== owner.origin || original.operatorId !== owner.operatorId) {
    throw new Error("CONVERSATION_OWNER_CHANGED: the preserved submission belongs to another operator");
  }
  let row = original;
  const envelope = envelopeOf(row);
  try {
    owner = await verifyOwner(owner, signal);
    {
      let status;
      try { status = await getCommand(row.id, signal, ownerHeaders(owner)).catch((error: unknown) => {
        forgetRefusedOwner(owner, error); throw error;
      }); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404 ||
            error.acknowledgedSession !== owner.sessionId || error.code !== "NOT_FOUND" || row.status !== null) throw error;
        owner = await verifyOwner(owner, signal);
        if (owner.csrf === null) throw new Error("AUTH_REQUIRED: authenticate to resend the preserved message");
        status = await submitCommand(envelope, { csrf: owner.csrf, signal });
      }
      assertOwner(owner, signal);
      row = await recordStatus(owner, row, status, false, true);
      for (let poll = 0; effectiveStatus(row)?.status === "PENDING" && poll < 20; poll += 1) {
        await pause(signal);
        owner = await verifyOwner(owner, signal);
        const current = await getCommand(row.id, signal, ownerHeaders(owner)).catch((error: unknown) => {
        forgetRefusedOwner(owner, error); throw error;
      });
        assertOwner(owner, signal);
        row = await recordStatus(owner, row, current, false, true);
      }
    }
    const status = effectiveStatus(row);
    if (status === null) throw new Error("CONVERSATION_RECEIPT_UNAVAILABLE");
    const receipt = receiptFor(status, envelope, owner.operatorId);
    const observed = await getConversation(owner, receipt.cursor.conversation_id,
      receipt.cursor.sequence - 1, payloadOf(envelope).cursor?.message_id, signal);
    if (!confirmsReceipt(observed.data, receipt, row.id)) {
      throw new Error("CONVERSATION_READBACK_UNAVAILABLE: preserved receipt has not been observed");
    }
    // Receipt settlement must not depend on downloading an arbitrarily long history.
    owner = await verifyOwner(owner, signal);
    row = await recordStatus(owner, row, status, true);
    const thread = await readConversationWindow(owner, receipt.cursor.conversation_id, visibleMessages, signal);
    assertOwner(owner, signal);
    if (thread.asOfSequence < observed.asOfSequence || thread.data.cursor.sequence < observed.data.cursor.sequence) {
      throw new Error("CONVERSATION_SNAPSHOT_REGRESSED: message settled; visible history needs a newer observation");
    }
    return { submission: row, thread };
  } catch (error) {
    forgetRefusedOwner(owner, error); throw error;
  }
}

export async function submitConversation(owner: ConversationOwner, content: string, cursor: ConversationCursor | null,
  signal?: AbortSignal, draftRevision?: string, visibleMessages = PAGE_LIMIT): Promise<{ submission: Submission; thread: SnapshotRead<ConversationView> }> {
  assertOwner(owner, signal);
  const requested = conversationEnvelope(content, cursor);
  const row = await reserveSubmission(owner, requested, draftRevision);
  if (canonicalCommandPayload(payloadOf(envelopeOf(row))) !== canonicalCommandPayload(payloadOf(requested))) {
    throw new Error("CONVERSATION_JOURNAL_CONFLICT: reconcile your preserved submission first");
  }
  assertOwner(owner, signal);
  return reconcileSubmission(owner, row, signal, visibleMessages);
}
