# Portal architecture

The Control Tower is a projection of the kernel ledger. Hash routes
`#/<surface-id>` cover every spec §25 surface. Control Tower, Mission Graph,
Live Attempt, and Incidents & Audit read farmd projections; the other eleven
surfaces have no farmd projection and render `unknown`, never an empty
success list.

The three projected surfaces (`src/pages/ProjectedSurface.tsx`) combine
`GET /v1/missions/{id}` and `GET /v1/ready` and require both responses to
carry the same `X-Bullet-As-Of-Sequence` watermark; a mismatch renders
`unknown` with `SNAPSHOT_WATERMARK_MISMATCH`. `/v1/ready` answers 404 while
the ready queue is empty, which the client maps to a null watermark, so an
idle farmd shows Live Attempt as `unknown` rather than as a healthy empty
list.

Operators diagnose from durable projections and `/v1/events`. The browser
never holds authority, and no view mutates authoritative state optimistically.
The current component build has no public `/v1/commands` ledger, authenticated
browser session, or CSRF boundary. Its Run button calls `POST /v1/demo/run`
directly and renders that request's local phase and returned demo receipt. This
must not be interpreted as a durable command or transaction result.

## Status vocabulary

Spec §25 vocabulary: PENDING, CONFIRMED, FAILED, UNKNOWN, STALE,
CONTRADICTORY. Portal rendering:

- Mutation phases: `idle` (nothing requested, neutral), `pending` (the direct
  demo request is in flight, amber), `verified` (the demo endpoint returned its
  component receipt, green), `failed` (transport or endpoint failure, red —
  the error stays visible until the next request). The `verified` view label is
  not a public command `VERIFIED` state or release evidence.
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

Observation cards with a value name their source and observed-at time
(`GET /v1/missions`, `GET /v1/outbox`, `farmd /health`); projected surfaces
name their spec section and `as_of_sequence`. The Control Tower header shows
`as_of_sequence`, projection lag, source health from a real `/health` probe
(10s timeout), and the stream connection state. Endpoints consumed:
`GET /v1/missions`, `GET /v1/missions/{id}`, `GET /v1/outbox`,
`GET /v1/ready`, `POST /v1/demo/run`, `GET /health`, and
`GET /v1/events?after=<seq>`.

Development is same-origin: Vite proxies `/v1`, `/health`, and
`/openapi.yaml` to loopback farmd. Farmd does not expose wildcard CORS, so the
hub launcher clears `VITE_BULLET_API` instead of directing browser requests to
a different origin. The current real-farmd browser lane also uses a Vite
development server and the synthetic demo endpoint; it is component evidence,
not embedded-production-Portal or command-ledger evidence.

## Event stream

`src/hooks/useEventStream.ts` consumes `GET /v1/events?after=<seq>`. Kernel
framing: SSE `id` = ledger seq and each default-message `data` is the generated
`Event` JSON (`id`, `seq`, `at`, `kind`, `body`). The fetch-based SSE parser
(`src/sse.ts`) validates the content type and skips keep-alive comments; the
hook owns the exclusive sequence cursor and carries it across reconnects.

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
- All wire DTOs come from `src/generated/api.ts`, a generated zone copied
  verbatim from `bullet-kernel/contracts/generated/api.ts` (regenerate with
  `cargo run -p bullet -- contracts generate` in the kernel, then `just setup`
  from the hub copies it). The portal declares no duplicate of a generated
  DTO; its only local shapes are view-side (`ParsedEvent`, projection
  bodies) and never cross the wire.
