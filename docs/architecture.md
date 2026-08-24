# Portal architecture

The Control Tower is a projection of the kernel ledger. Hash routes
`#/<surface-id>` cover every spec §25 surface. Surfaces without a farmd
projection render `unknown`, never an empty success list.

Operators diagnose from durable projections and `/v1/events`. The browser
never holds authority: a click creates a durable command that renders as
pending until the ledger's recorded result comes back, and no view mutates
authoritative state optimistically.

## Status vocabulary

Spec §25 vocabulary: PENDING, CONFIRMED, FAILED, UNKNOWN, STALE,
CONTRADICTORY. Portal rendering:

- Mutation phases: `idle` (nothing requested, neutral), `pending` (durable
  command requested, amber), `verified` (ledger-confirmed receipt, green),
  `failed` (transport or ledger reported failure, red — the error stays
  visible until the next request).
- Outbox delivery phases come from the kernel wire names
  (`CommandPhase::as_str`): `pending` and `applied` render amber, `verified`
  renders green, `unknown` — and any unrecognized phase — renders red.
- Observations use the generated `ObservationKind` (`value`, `empty`,
  `unknown`, `contradictory`). UNKNOWN is never rendered as healthy and never
  as an authoritative EMPTY: a failed `GET /v1/missions` renders
  `unknown: control plane unreachable (…)`, never "No missions yet.".
  "No missions yet." and "outbox: empty (verified)" render only from an
  HTTP 200 with a JSON body.
- The demo receipt renders `effect_unknown_outcome` through the unknown
  style: it is the kernel's honest OUTCOME-unknown demonstration and must
  never look like success.
- STALE renders as a badge when the event stream detects a sequence gap. The
  acknowledged cursor stays at the last contiguous sequence. It clears only
  when replay fills the gap or both snapshot reads return watermarks covering
  it; a failed or unwatermarked read remains STALE.

## Sources and confidence

Every card names its source and observed-at time (`GET /v1/missions`,
`GET /v1/outbox`, `farmd /health`). The header line shows `as_of_sequence`,
projection lag, source health from a real `/health` probe (10s timeout), and
the stream connection state.

## Event stream

`src/hooks/useEventStream.ts` consumes `GET /v1/events?after=<seq>`. Kernel
framing: SSE `id` = ledger seq and each default-message `data` is the generated
`EventEnvelope` JSON. The fetch-based SSE parser (`src/sse.ts`) skips keep-alive
comments and retains the exclusive sequence cursor across reconnects.

- sequence comes from `Event.seq` (falling back to the SSE id); dedupe uses
  `Event.id` (falling back to the SSE id) with bounded memory;
- projection lag uses durable `Event.at`; malformed/missing timestamps remain
  unknown rather than becoming browser arrival time;
- a sequence jump sets STALE and triggers a snapshot refetch; replay or a
  covering `X-Bullet-As-Of-Sequence` watermark advances the acknowledged cursor;
- the connection state is always visible — `live`, `reconnecting`, or
  `unknown (events stream unavailable)` — never silently stale;
- on any stream end or failure the portal reconnects with
  `after=<last seq>` every 10s; while the endpoint is unreachable the page
  still works from snapshot fetches.

## Error handling

- `src/api.ts` wraps every request in a 10s `AbortController` timeout and a
  JSON content-type check; failures throw `ApiError` carrying method, URL,
  and status, and that text is what the UI shows.
- An error boundary around the app renders the failure reason — no white
  screens.
- All DTOs come from `src/generated/api.ts`, a generated zone re-synced
  verbatim from `bullet-kernel/contracts/generated/api.ts`; the portal adds
  no handwritten DTOs.
