# Portal architecture

The Control Tower is a projection of the kernel ledger. Hash routes
`#/<surface-id>` cover all fifteen spec §25 surfaces declared in
`src/surfaces.ts`. Nine surfaces read farmd projections: Control Tower
(`src/pages/ControlTower.tsx`) and the eight members of `PROJECTED_SURFACES`
in `src/pages/ProjectedSurface.tsx` — Mission Graph, Live Attempt, Fleet,
Session Supervisor, Context Lineage, Merge Rail, Quality Lab, and Incidents &
Audit. Context Lineage publishes only initial revision-one capsule subjects
and digests; it does not claim successor/compression lineage or expose raw
objective/title. The other six — Cognitive Router, Fusion Lab, Quota and
Capacity, Struggle and Escalation, Behavior Center, and Workspace and Git Hygiene — carry
an `unknownReason` in `src/surfaces.ts` and render through
`src/pages/SurfacePage.tsx` as `unknown: <title>: no ledger subject exists for
this surface yet: …`, naming the missing durable subject and the V1 slice that
produces it; never an empty success list. [`projections.md`](projections.md)
is the per-surface contract and quotes the six reasons verbatim.

Every projected read goes through `readSnapshot` in `src/api.ts`: one atomic
ledger snapshot `{data, as_of_sequence, observed_at, source}` whose
`x-bullet-as-of-sequence` response header must equal the body watermark. A
surface that composes several reads — Mission Graph (`GET /api/v1/missions` plus
one `GET /api/v1/missions/{id}` per mission), Live Attempt (the same plus
`GET /api/v1/ready`), Incidents & Audit (`GET /api/v1/audit` plus `GET /api/v1/outbox`) —
passes them through `atomicSnapshot` (`src/hooks/useProjection.ts`), which
refuses differing watermarks with `SNAPSHOT_WATERMARK_MISMATCH` and differing
sources with `SNAPSHOT_SOURCE_MISMATCH`; the surface then renders `unknown`.
`GET /api/v1/ready` answers HTTP 200 with `data: null` while the ready queue is
empty (kernel `apps/bullet-farmd/src/leases.rs`, `next_ready`); the client
accepts only that shape as an empty queue and treats HTTP 404 as a failed read
(`src/api.test.ts`, "never infers empty from 404"), so an idle farmd shows Live
Attempt as `{"ready": null, "graphs": []}` under its watermark, not as a
healthy list.

Operators diagnose from durable projections and `/api/v1/events`. No view mutates
authoritative state optimistically. The browser receives only a local,
session-bound mutation capability: farmd exchanges one short-lived CLI
bootstrap for an HttpOnly/SameSite cookie and CSRF value, then authorizes
`POST /api/v1/commands`. The Portal never treats HTTP acceptance as completion; it
polls the returned id through `GET /api/v1/commands/{id}`. The same-origin CSRF
value is retained in memory with best-effort session-storage continuity and has
no mutation authority without the HttpOnly cookie. A missing or stale pair
fails at farmd.

## Status vocabulary

Spec §25 vocabulary: PENDING, CONFIRMED, FAILED, UNKNOWN, STALE,
CONTRADICTORY. Portal rendering:

- Mutation phases use the exact public command names. `PENDING` and `APPLIED`
  render amber; persisted `FAILED` renders red; persisted or locally
  unobservable `UNKNOWN` renders unknown. `VERIFIED` may render green only when
  a generated runtime contract validates the exact Candidate, independent
  Evidence, Effect receipt, and command correlation. The current
  `CommandStatus.result` is generic JSON, so a bare durable `VERIFIED` is
  discarded and displayed as local `UNKNOWN`; the displayable phase type
  excludes `VERIFIED`, and no command path is green. `IDLE` is neutral. A
  successful POST must be exact HTTP 202 with a validated `PENDING` subject and
  still does not render green.
- Outbox delivery phases come from the kernel wire names
  (`CommandPhase::as_str`): `pending` and `applied` render amber. The exact raw
  `verified` value is preserved but renders unknown with `receipt unavailable`:
  generated `OutboxItem` carries no Candidate, independent Evidence, Effect
  receipt, or command-correlation subject that could authorize green.
  `unknown` — and any unrecognized phase — also renders unknown.
- Observations use the generated `ObservationKind` (`value`, `empty`,
  `unknown`, `contradictory`). UNKNOWN is never rendered as healthy and never
  as an authoritative EMPTY: a failed `GET /api/v1/missions` renders
  `unknown: control plane unreachable (…)`, never "No missions yet.".
  "No missions yet." and "outbox: empty (observed)" render only from an
  HTTP 200 with a JSON body.
- Projected tables (`RowsTable` in `src/components/ProjectionCard.tsx`) render
  an empty set as `<label>: 0 rows (verified at sequence N)` in the neutral
  idle style, never in the green `verified` class; a null field prints its
  meaning (`contradictory: attempt row missing`, `not recorded`, `absent`).
- Every status read must repeat the admitted command id, kind, and payload
  digest. A conflicting subject or a response/transport timeout becomes local
  UNKNOWN, as does an APPLIED-to-PENDING regression. Starting a later command
  clears the older command before transport, so an older verified result cannot
  color a newer failed or unknown request.
- STALE renders as a badge when the event stream detects a sequence gap. The
  acknowledged cursor stays at the last contiguous sequence. It clears only
  when replay fills the gap or both snapshot reads return watermarks covering
  it; a failed or unwatermarked read remains STALE.

## Sources and confidence

Observation cards with a value name their source and observed-at time
(`GET /api/v1/missions`, `GET /api/v1/outbox`, `farmd /health`); projected surfaces
name their spec section, `as_of_sequence`, `source`, `observed_at`, and
freshness. The Control Tower header shows `as_of_sequence`, projection lag,
source health from a real `/health` probe (10s timeout), and the stream
connection state. Endpoints consumed (`src/api.ts` and
`src/hooks/useEventStream.ts`):
`GET /health`, `GET /api/v1/missions`, `GET /api/v1/missions/{id}`, `GET /api/v1/outbox`,
`GET /api/v1/ready`, `GET /api/v1/fleet`, `GET /api/v1/sessions`,
`GET /api/v1/context-lineage`, `GET /api/v1/merge-rail`, `GET /api/v1/quality-lab`,
`GET /api/v1/audit`, `POST /api/v1/auth/bootstrap`,
`POST /api/v1/commands`, `GET /api/v1/commands/{id}`, and
`GET /api/v1/events?after=<seq>`. All fifteen are mounted by kernel
`apps/bullet-farmd/src/api.rs`; the ten `GET /api/v1/…` reads other than
`/api/v1/commands/{id}` and `/api/v1/events` are snapshot routes under the contract in
`projections.md`.

Development and built-bundle proof are same-origin: Vite dev and preview
proxy only `/api/v1`, `/health`, and `/openapi.yaml` to loopback farmd. Farmd does
not expose wildcard CORS. Product requests use an empty origin base plus the
Kernel-generated `API_PREFIX`; Vite refuses nonempty `VITE_BULLET_API`
configuration rather than directing a browser bundle to another origin. The
real-farmd browser lane (`ops/ci/real-farmd.sh`, `e2e/real-farmd.spec.ts`, 3 tests) rebuilds and
serves `dist`, builds the sibling `bullet-kernel` farmd, captures its one-time
bootstrap without logging it, proves cookie/Origin/CSRF/202/status
reconciliation through the worker-token reconcile route, and checks that the
six list projections answer from one shared watermark while empty Fleet and
Context Lineage render zero rows without green. The preview server is test scaffolding, not
the missing Rust asset embedding. Because no dispatch, APPLIED, or VERIFIED
path exists, the exact real results are durable `PENDING` and, after the
worker reconcile, durable `UNKNOWN` (`EXECUTION_ADAPTER_UNAVAILABLE`); neither
is transaction completion. The browser proof also asserts that the reconciled
command card contains no green status.

## Event stream

`src/hooks/useEventStream.ts` consumes `GET /api/v1/events?after=<seq>`. Kernel
framing: SSE `id` = ledger seq and each default-message `data` is the generated
`EventEnvelope` JSON (`id`, `seq`, `at`, `kind`, `body`). The fetch-based SSE parser
(`src/sse.ts`) validates the content type and skips keep-alive comments; the
hook owns the exclusive sequence cursor and carries it across reconnects.

- durable identity and sequence come only from the generated `EventEnvelope`;
  the SSE id must be a safe nonnegative integer exactly equal to `EventEnvelope.seq`,
  with no transport-metadata fallback, and dedupe uses `EventEnvelope.id` with
  bounded memory;
- projection lag uses durable `EventEnvelope.at`; malformed/missing timestamps remain
  unknown rather than becoming browser arrival time;
- a sequence jump sets STALE and triggers a snapshot refetch; replay or a
  covering `X-Bullet-As-Of-Sequence` watermark advances the acknowledged cursor;
- the connection state is always visible — `live`, `reconnecting`, or
  `unknown (events stream unavailable)` — never silently stale;
- the initial request uses `?after=<acknowledged seq>`; after any stream end or
  failure the portal retries `/events` every 10s with the exact acknowledged
  sequence in `Last-Event-ID`. Snapshot gap recovery also rebases through that
  header immediately; while the endpoint is unreachable the page still works
  from snapshot fetches.

## Error handling

- `src/api.ts` wraps every request in a 10s `AbortController` timeout and a
  JSON content-type check. Projection reads additionally require the exact
  four-field snapshot body, current Kernel source, RFC 3339 observation time,
  safe nonnegative sequence, and an equal required watermark header. Failures
  throw `ApiError` carrying method, URL, and status, and that text is what the
  UI shows. Bootstrap and command responses use their generated non-snapshot
  shapes; command admission additionally requires exact HTTP 202.
- Projection value timestamps and source labels come from the validated Kernel
  snapshot. Transport/schema failures are timestamped locally as
  `portal/local`; a 404 is never converted into a successful empty projection.
- An error boundary around the app renders the failure reason — no white
  screens.
- All wire DTOs come from `src/generated/api.ts`, a generated zone copied
  verbatim from `bullet-kernel/contracts/generated/api.ts` (regenerate with
  `cargo run -p bullet -- contracts generate` in the kernel, then `just setup`
  from the hub copies it); `src/generated/schemaBundle.ts` is synced from the
  hub by `scripts/sync-family-contracts.sh` (`agent/generated-zones.toml`).
  The portal declares no duplicate of a generated DTO; its only local shapes
  are view-side (`ParsedEvent`, composed projection bodies) and never cross
  the wire. Request construction, JSON decoding, and SSE framing/reconnect are
  still handwritten in `src/api.ts`, `src/apiValidation.ts`, `src/sse.ts`, and
  `src/hooks/useEventStream.ts`; their strict validation is component-tested,
  but no generated transport client or generator drift boundary exists yet.
