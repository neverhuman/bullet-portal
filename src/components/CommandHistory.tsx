import { useEffect, useRef, useState } from "react";
import { ApiError, errorText, getCommand, type SnapshotRead } from "../api";
import { listCommands } from "../apiCommands";
import type { CommandDiscoveryView, CommandStatus } from "../generated/api";
import { CommandCard } from "./CommandCard";

function sameSubject(left: CommandStatus, right: CommandStatus): boolean {
  return left.id === right.id && left.kind === right.kind && left.payload_digest === right.payload_digest;
}

function assertCurrent(previous: CommandStatus, next: CommandStatus): void {
  if (!sameSubject(previous, next)) throw new Error("command identity or payload changed");
  if (previous.status !== "PENDING" && next.status === "PENDING") {
    throw new Error("command phase moved backwards to PENDING");
  }
}

export function CommandHistory({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [page, setPage] = useState<SnapshotRead<CommandDiscoveryView> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CommandStatus | null>(null);
  const [detail, setDetail] = useState<CommandStatus | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const pageRequest = useRef(0);
  const detailRequest = useRef(0);
  const selection = useRef<CommandStatus | null>(null);
  const cursor = useRef(0);
  const watermark = useRef(0);

  function unauthorized(err: unknown): boolean {
    if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) return false;
    pageRequest.current += 1;
    detailRequest.current += 1;
    selection.current = null;
    setPage(null); setSelected(null); setDetail(null); setBusy(false); setDetailBusy(false);
    onUnauthorized();
    return true;
  }

  async function select(command: CommandStatus): Promise<void> {
    const request = ++detailRequest.current;
    const previous = selection.current?.id === command.id ? selection.current : command;
    selection.current = previous; setSelected(previous); setDetail(null); setDetailError(null); setDetailBusy(true);
    try {
      if (!sameSubject(previous, command)) throw new Error("command identity or payload changed");
      const current = await getCommand(command.id);
      if (request !== detailRequest.current) return;
      assertCurrent(previous, current);
      selection.current = current; setSelected(current);
      setDetail(current);
    } catch (err) {
      if (request !== detailRequest.current) return;
      if (unauthorized(err)) return;
      setDetailError(`Current command unavailable: ${errorText(err)}`);
    } finally {
      if (request === detailRequest.current) setDetailBusy(false);
    }
  }

  async function refresh(after: number): Promise<void> {
    const request = ++pageRequest.current;
    detailRequest.current += 1;
    setBusy(true); setError(null); setDetail(null); setDetailError(null); setDetailBusy(false);
    try {
      const next = await listCommands(after);
      if (request !== pageRequest.current) return;
      if (next.asOfSequence < watermark.current) throw new Error("history watermark moved backwards");
      const previous = selection.current;
      const retained = next.data.commands.find((command) => command.id === previous?.id) ?? null;
      if (retained !== null && previous !== null) assertCurrent(previous, retained);
      cursor.current = after; watermark.current = next.asOfSequence;
      setPage(next); setSelected(retained); selection.current = retained;
      if (retained !== null) void select(retained);
    } catch (err) {
      if (request !== pageRequest.current) return;
      if (unauthorized(err)) return;
      setError(`Command history unavailable: ${errorText(err)}`);
    } finally {
      if (request === pageRequest.current) setBusy(false);
    }
  }

  useEffect(() => {
    void refresh(0);
    return () => { pageRequest.current += 1; detailRequest.current += 1; };
  }, []);

  return (
    <section className="card" aria-label="Command history" aria-busy={busy}>
      <h2>Command history</h2>
      <p>Commands owned by your operator account, including work submitted from another client.</p>
      <button type="button" disabled={busy} onClick={() => void refresh(cursor.current)}>Refresh history</button>{" "}
      <button type="button" disabled={busy || cursor.current === 0} onClick={() => void refresh(0)}>First page</button>{" "}
      <button type="button" disabled={busy || page?.data.next_after == null}
        onClick={() => { if (page?.data.next_after != null) void refresh(page.data.next_after); }}>Next page</button>
      {busy && <p role="status">Reading command history…</p>}
      {error !== null && <p className="unknown" role="alert">{error}{page !== null ? " Previous page retained." : ""}</p>}
      {page !== null && <>
        <p className="source">History snapshot {page.asOfSequence} · observed {page.observedAt} · {page.source}</p>
        {page.data.commands.length === 0 ? <p>No commands on this observed page.</p> : <ul>
          {page.data.commands.map((command) => <li key={command.id}>
            <button type="button" disabled={busy} aria-pressed={selected?.id === command.id}
              onClick={() => void select(command)}>{command.id}</button>{" "}
            {command.kind} · <span className={command.status === "FAILED" ? "failed" : "unknown"}>
              {command.status === "VERIFIED" ? "VERIFIED (receipt unavailable)" : command.status}
            </span>
          </li>)}
        </ul>}
      </>}
      {detailBusy && <p role="status">Reading current command…</p>}
      {detailError !== null && <p className="unknown" role="alert">{detailError}</p>}
      {detail !== null && <CommandCard command={detail} />}
    </section>
  );
}
