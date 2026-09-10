import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEventStream } from "../../hooks/useEventStream";
import { useConversation } from "./useConversation";
import { TalkDrawer } from "./TalkDrawer";
import { conversationEnvelope } from "./contracts";
import { prepareCommand } from "../../commandIdentity";
import { SNAPSHOT_SOURCE } from "../../apiValidation";
import { session, thread } from "./fixture.test-support";
import type { Submission } from "./journal";

vi.mock("./useConversation", () => ({ useConversation: vi.fn() }));
vi.mock("../../hooks/useEventStream", () => ({ useEventStream: vi.fn() }));
function row(): Submission {
  const prepared = prepareCommand(conversationEnvelope("preserved human text", null));
  return { schema: 1, origin: location.origin, operatorId: session.operator_id, destination: "/api/v1/commands",
    id: prepared.subject.id, body: prepared.body, status: { ...prepared.subject, status: "UNKNOWN", result: {} }, refreshed: false };
}
function state(): ReturnType<typeof useConversation> {
  return { owner: { origin: location.origin, operatorId: session.operator_id, sessionId: session.session_id, epoch: 0, csrf: null },
    index: null, thread: null, selected: null, draft: "next instruction", draftRevision: "draft", submission: null,
    history: [], historyAfter: null, busy: false, error: null, refresh: vi.fn(async () => 0), select: vi.fn(),
    moreThreads: vi.fn(), moreMessages: vi.fn(), moreHistory: vi.fn(), archive: vi.fn(), send: vi.fn(),
    reconcile: vi.fn(), setDraft: vi.fn() };
}
let talk: ReturnType<typeof state>;
beforeEach(() => {
  talk = state(); vi.mocked(useConversation).mockImplementation(() => talk);
  vi.mocked(useEventStream).mockReturnValue({ connection: "live", stale: false } as ReturnType<typeof useEventStream>);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function open() { render(<TalkDrawer />); fireEvent.click(screen.getByRole("button", { name: "Head" })); }

it("opens the labelled pane, focuses the editor, and restores the launcher on Escape and close", () => {
  open();
  const editor = screen.getByLabelText("Message the Head"); expect(editor).toHaveFocus();
  const head = screen.getByRole("button", { name: "Head" });
  expect(head).toHaveAttribute("aria-controls", screen.getByRole("complementary").id);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull(); expect(head).toHaveFocus();
  fireEvent.click(head); fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
  expect(head).toHaveFocus();
});

it("reserves Ctrl+Enter for valid submission and leaves newline/composition alone", () => {
  open(); const editor = screen.getByLabelText("Message the Head");
  fireEvent.change(editor, { target: { value: "changed" } }); expect(talk.setDraft).toHaveBeenCalledWith("changed");
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, isComposing: true });
  expect(talk.send).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true }); expect(talk.send).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Send message" })); expect(talk.send).toHaveBeenCalledTimes(2);
});

it.each(["busy", "owner", "draft", "pending"])("applies the same %s refusal to keyboard and button", (reason) => {
  if (reason === "busy") talk.busy = true;
  if (reason === "owner") talk.owner = null;
  if (reason === "draft") talk.draft = "   ";
  if (reason === "pending") talk.submission = row();
  open();
  expect(screen.getByRole("button", { name: reason === "busy" ? "Working…" : "Send message" })).toBeDisabled();
  fireEvent.keyDown(screen.getByLabelText("Message the Head"), { key: "Enter", ctrlKey: true });
  expect(talk.send).not.toHaveBeenCalled();
});

it("shows exact historical recovery beside the original failure and a newer reconciliation", () => {
  const saved = row(); talk.submission = saved; talk.history = [{ ...saved, reconciledStatus: { ...saved.status!, status: "FAILED" } }];
  talk.historyAfter = saved.id; talk.error = "transport uncertain";
  open();
  expect(screen.getByRole("alert")).toHaveTextContent("transport uncertain");
  fireEvent.click(screen.getByRole("button", { name: "Reconcile preserved submission" })); expect(talk.send).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep this unresolved record and allow another message" })); expect(talk.archive).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Saved submissions"));
  fireEvent.click(screen.getByText(`UNKNOWN · ${saved.id}`));
  expect(screen.getByText("Original receipt: UNKNOWN. Later authoritative observation: FAILED.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reconcile this submission" })); expect(talk.reconcile).toHaveBeenCalledWith(talk.history[0]);
  fireEvent.click(screen.getByRole("button", { name: "Load more saved submissions" })); expect(talk.moreHistory).toHaveBeenCalledOnce();
});

it("preserves page navigation, exact observation metadata and honest Head admission state", () => {
  const saved = row(); const view = thread(saved);
  talk.selected = view.cursor.conversation_id;
  talk.thread = { data: { ...view, next_after: 1 }, asOfSequence: 20, observedAt: session.issued_at, source: SNAPSHOT_SOURCE };
  talk.index = { ...talk.thread, data: { conversations: [{ cursor: view.cursor, preview: "a saved conversation",
    created_at: session.issued_at, last_activity_at: session.issued_at }], next_after: 2 } };
  open();
  expect(screen.getByTestId("talk-blocker")).toHaveTextContent("Messages are saved. Head execution is awaiting runtime admission.");
  expect(screen.getByText(`Observed ${session.issued_at} · record 20`)).toBeVisible();
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh conversations" })); expect(talk.refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Load more conversations" })); expect(talk.moreThreads).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Load more messages" })); expect(talk.moreMessages).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Conversation"), { target: { value: "" } }); expect(talk.select).toHaveBeenCalledWith(null);
});

it("reports interrupted updates and invokes authoritative refresh for stream invalidation", async () => {
  vi.mocked(useEventStream).mockReturnValue({ connection: "reconnecting", stale: true } as ReturnType<typeof useEventStream>);
  open(); expect(screen.getByRole("status")).toHaveTextContent("Resynchronizing from saved records");
  const [gap, event] = vi.mocked(useEventStream).mock.calls.at(-1)!;
  await gap(1); event?.(2); expect(talk.refresh).toHaveBeenCalledTimes(2);
});
