# Portal architecture

The Control Tower is a projection of the kernel ledger. The browser never
holds authority: a click creates a durable command that renders as pending
until the ledger's recorded result comes back, and no view mutates
authoritative state optimistically.

## Status vocabulary

Spec §25 vocabulary: PENDING, CONFIRMED, FAILED, UNKNOWN, STALE,
CONTRADICTORY. Portal rendering:

- Mutation phases: `idle` (nothing requested, neutral), `pending` (durable
  command requested, amber), `verified` (ledger-confirmed receipt, green),
  `failed` (transport or ledger reported failure, red — the error stays
  visible until the next request).
- Observations use the generated `ObservationKind` (`value`, `empty`,
  `unknown`, `contradictory`). UNKNOWN is never rendered as healthy and never
  as an authoritative EMPTY: a failed `GET /v1/missions` renders
  `unknown: control plane unreachable (…)`, never "No missions yet.".
  "No missions yet." and "outbox: empty (verified)" render only from an
  HTTP 200 with a JSON body.
- STALE renders as a badge when the event stream detects a sequence gap; it
  clears only after a successful snapshot refetch.

## Sources and confidence

Every card names its source and observed-at time (`GET /v1/missions`,
`GET /v1/outbox`, `farmd /health`). The header line shows `as_of_sequence`,
projection lag (now minus the last event time), source health from a real
`/health` probe (10s timeout), and the stream connection state.

## Event stream

`src/hooks/useEventStream.ts` opens an `EventSource` on
`/v1/events?after=<seq>`:

- tracks the last sequence and dedupes by event id (bounded id memory);
- a sequence jump sets STALE and triggers a snapshot refetch; STALE clears
  only when that refetch succeeds;
- the connection state is always visible — `live`, `reconnecting`, or
  `unknown (events stream unavailable)` — never silently stale;
- while the kernel endpoint is absent the page still works from snapshot
  fetches and retries the stream every 10s.

## Error handling

- `src/api.ts` wraps every request in a 10s `AbortController` timeout and a
  JSON content-type check; failures throw `ApiError` carrying method, URL,
  and status, and that text is what the UI shows.
- An error boundary around the app renders the failure reason — no white
  screens.
- All DTOs come from `src/generated/api.ts`, a generated zone re-synced
  verbatim from `bullet-kernel/contracts/generated/api.ts`; the portal adds
  no handwritten DTOs.
