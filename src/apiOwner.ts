import { getOperatorSession } from "./apiAuth";
import { ApiError } from "./apiTransport";
import { browserSessionEpoch, csrfToken, forgetBrowserSession } from "./apiSession";

/** Nonsecret server identity plus page-local credentials; never serialize this context. */
export type ConversationOwner = {
  origin: string;
  operatorId: string;
  sessionId: string;
  epoch: number;
  csrf: string | null;
  readonly selection?: number;
};
let selected: ConversationOwner | null = null;
let selection = 0;

export function assertOwner(owner: ConversationOwner, signal?: AbortSignal): void {
  if (signal?.aborted || owner.origin !== window.location.origin ||
      owner.epoch !== browserSessionEpoch() || owner.csrf !== csrfToken()) {
    throw new Error("CONVERSATION_OWNER_CHANGED: authenticate again to recover your submission");
  }
}

export async function discoverOwner(signal?: AbortSignal): Promise<ConversationOwner> {
  const epoch = browserSessionEpoch();
  const csrf = csrfToken();
  const startedAt = selection;
  const session = await getOperatorSession(signal).catch((error: unknown) => {
    if (startedAt === selection && epoch === browserSessionEpoch() && csrf === csrfToken() &&
        (csrf !== null || selected?.epoch === epoch) &&
        error instanceof ApiError && (error.status === 401 || error.status === 403)) forgetBrowserSession();
    throw error;
  });
  const owner: ConversationOwner = { origin: window.location.origin, operatorId: session.operator_id,
    sessionId: session.session_id, epoch, csrf };
  assertOwner(owner, signal);
  if (selected?.epoch === epoch && (selected.operatorId !== owner.operatorId || selected.sessionId !== owner.sessionId)) {
    if (startedAt === selection) forgetBrowserSession();
    throw new Error("CONVERSATION_OWNER_CHANGED: the selected server session was replaced; authenticate again");
  }
  selected = { ...owner, selection: ++selection };
  return selected;
}

export async function verifyOwner(owner: ConversationOwner, signal?: AbortSignal): Promise<ConversationOwner> {
  assertOwner(owner, signal);
  const startedAt = selection;
  const session = await getOperatorSession(signal).catch((error: unknown) => {
    forgetRefusedOwner({ ...owner, selection: startedAt }, error);
    throw error;
  });
  assertOwner(owner, signal);
  if (session.operator_id !== owner.operatorId || session.session_id !== owner.sessionId) {
    if (startedAt === selection) forgetBrowserSession();
    throw new Error("CONVERSATION_OWNER_CHANGED: the server session changed; authenticate again");
  }
  selected = { ...owner, selection: ++selection };
  return selected;
}

export function ownerHeaders(owner: ConversationOwner): Record<string, string> {
  assertOwner(owner);
  return { "x-bullet-expected-session": owner.sessionId };
}

export function forgetRefusedOwner(owner: ConversationOwner, error: unknown): void {
  if ((owner.selection === undefined || owner.selection === selection) &&
      owner.epoch === browserSessionEpoch() && owner.csrf === csrfToken() &&
      error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    forgetBrowserSession();
  }
}
