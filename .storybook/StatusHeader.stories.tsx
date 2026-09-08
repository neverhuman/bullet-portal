import type { EventStreamState } from "../src/hooks/useEventStream";
import { StatusHeader } from "../src/components/StatusHeader";

const live: EventStreamState = {
  connection: "live",
  detail: "",
  asOfSequence: 8,
  lastEventAt: "2026-08-24T22:00:00.000Z",
  stale: false,
};

export default {
  title: "StatusHeader",
  component: StatusHeader,
};

export const Live = {
  render: () => (
    <StatusHeader
      stream={live}
      health={{
        kind: "value",
        value: "ok",
        observedAt: live.lastEventAt ?? "",
        source: "bullet-kernel/sqlite-ledger",
      }}
    />
  ),
};

export const Stale = {
  render: () => (
    <StatusHeader
      stream={{ ...live, stale: true, connection: "reconnecting", detail: "snapshot reconciled, reconnecting" }}
      health={{
        kind: "unknown",
        reason: "GET /health failed",
        observedAt: live.lastEventAt ?? "",
        source: "portal/local",
      }}
    />
  ),
};
