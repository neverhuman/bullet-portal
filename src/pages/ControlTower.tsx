import { useCallback, useRef, useState } from "react";
import { ApiError, errorText, fetchOutbox, listMissions, runDemo } from "../api";
import { MissionsCard } from "../components/MissionsCard";
import { OutboxCard } from "../components/OutboxCard";
import { ReceiptCard } from "../components/ReceiptCard";
import { StatusHeader } from "../components/StatusHeader";
import type { DemoReceipt, Mission, OutboxView } from "../generated/api";
import { useEventStream } from "../hooks/useEventStream";
import { useHealthProbe } from "../hooks/useHealthProbe";
import type { Loadable } from "../loadable";
import { toSnapshotValue, toUnknown } from "../loadable";

type MutationPhase = "idle" | "pending" | "verified" | "failed" | "unknown";

const PHASE_CLASS: Record<MutationPhase, string> = {
  idle: "idle",
  pending: "pending",
  verified: "verified",
  failed: "failed",
  unknown: "unknown",
};

export function ControlTower() {
  const [missions, setMissions] = useState<Loadable<Mission[]>>({ kind: "loading" });
  const [outbox, setOutbox] = useState<Loadable<OutboxView>>({ kind: "loading" });
  const [receipt, setReceipt] = useState<DemoReceipt | null>(null);
  const [phase, setPhase] = useState<MutationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const health = useHealthProbe();

  const refreshMissions = useCallback(async (): Promise<number | null> => {
    try {
      const snapshot = await listMissions();
      setMissions(toSnapshotValue(snapshot.data, snapshot.observedAt, snapshot.source));
      return snapshot.asOfSequence;
    } catch (err) {
      setMissions(toUnknown(`control plane unreachable (${errorText(err)})`));
      return null;
    }
  }, []);

  const refreshOutbox = useCallback(async (): Promise<number | null> => {
    try {
      const snapshot = await fetchOutbox();
      setOutbox(toSnapshotValue(snapshot.data, snapshot.observedAt, snapshot.source));
      return snapshot.asOfSequence;
    } catch (err) {
      setOutbox(toUnknown(`outbox unreachable (${errorText(err)})`));
      return null;
    }
  }, []);

  const refreshSnapshot = useCallback(async (): Promise<number | null> => {
    const [missionsSequence, outboxSequence] = await Promise.all([
      refreshMissions(),
      refreshOutbox(),
    ]);
    return missionsSequence === null || outboxSequence === null
      ? null
      : Math.min(missionsSequence, outboxSequence);
  }, [refreshMissions, refreshOutbox]);

  const stream = useEventStream(refreshSnapshot);

  async function onRunDemo(): Promise<void> {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setPhase("pending");
    setError(null);
    setReceipt(null);
    try {
      const next = await runDemo();
      setReceipt(next);
      setPhase("verified");
    } catch (err) {
      const ambiguous = err instanceof ApiError && err.outcomeUnknown;
      setPhase(ambiguous ? "unknown" : "failed");
      setError(
        ambiguous
          ? `command outcome unknown; no command-id reconciliation endpoint is published (${errorText(err)})`
          : errorText(err),
      );
      return;
    } finally {
      runningRef.current = false;
    }
    await refreshSnapshot();
  }

  return (
    <main>
      <h1>Control Tower</h1>
      <p className="tagline">Many minds. One verified line to main.</p>
      <StatusHeader stream={stream} health={health.state} />
      <button type="button" disabled={phase === "pending"} onClick={() => void onRunDemo()}>
        Run simulator demo
      </button>
      <p className={PHASE_CLASS[phase]} data-testid="phase">
        mutation phase: {phase}
      </p>
      {error !== null ? (
        <p className={PHASE_CLASS[phase]} data-testid="mutation-error">
          {error}
        </p>
      ) : null}
      <MissionsCard missions={missions} />
      <OutboxCard outbox={outbox} />
      {receipt !== null ? <ReceiptCard receipt={receipt} /> : null}
    </main>
  );
}
