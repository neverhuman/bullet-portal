# Portal projections

Status: component contract consuming Kernel `c3a7009`; no release claim
Owner: Bullet Farm maintainers
Last reviewed: 2026-08-25
Applies to: bullet-portal

This document states what the browser reads, how each read is validated, and
what each of the fifteen spec §25 surfaces shows or refuses to show. Every
statement names its source file. `src/generated/api.ts` is the generated
kernel contract (`agent/generated-zones.toml`); the portal declares no wire
DTO of its own. The parity checks at the end keep this file honest against
`src/surfaces.ts` and `src/api.ts`.

## Snapshot contract: one route, one atomic read

`readSnapshot(path, validateData)` in `src/api.ts` is the only way a
projection enters the browser. A response is accepted only when all of the
following hold (`src/apiValidation.ts`: `isSnapshotEnvelope`; `src/api.ts`:
`fetchJson`, `readSnapshotSequence`):

- HTTP 2xx within the 10 s `AbortController` timeout, media type
  `application/json`, and a parseable JSON body. Any other status becomes an
  `ApiError` (an `application/problem+json` body whose `status` matches is
  parsed into `code`, `request_id`, and `repair`); a 404 is a failed read,
  never an empty projection.
- The body has exactly the four keys `data`, `as_of_sequence`, `observed_at`,
  `source` (`hasExactKeys`); `as_of_sequence` is a safe integer `>= 0`;
  `observed_at` is RFC 3339 with a real calendar day (`isRfc3339`); `source`
  is exactly `bullet-kernel/sqlite-ledger` (`SNAPSHOT_SOURCE`).
- `data` passes the generated AJV validator for its DTO
  (`PUBLIC_API_RUNTIME_SCHEMA`, compiled with `strict: true`; the schema sets
  `additionalProperties: false`), plus local refinements: `MissionView.fence`
  is null or an integer; `ReadyView` may be `null`; `AuditView` must satisfy
  `auditTailIsCoherent` — at most `tail_window` events, contiguous `seq`, and
  the last `seq` equal to `latest_sequence` (an empty tail only when
  `latest_sequence === 0`). `ContextLineageView` and its DTO are generated,
  but the Kernel generator has not exported that view as an AJV root; the
  adjacent strict `isContextLineageView` validates every generated field,
  exact keys, typed IDs/digests, the exact closed 16-value snake_case
  `TaskClass` catalog, revision one, null parent, `compression: "none"`, empty
  dropped decisions, and RFC 3339 `recorded_at` without declaring a second
  wire DTO.
- The `x-bullet-as-of-sequence` response header is present, canonical
  decimal (`/^(?:0|[1-9]\d*)$/`), a safe integer, and equal to
  `body.as_of_sequence`. Otherwise the read throws `snapshot watermark header
  is missing`, `… is invalid`, or `snapshot watermark header/body mismatch`.

The result is `SnapshotRead<T> = {data, asOfSequence, observedAt, source}`.
On the kernel side each route builds its body inside one
`ledger.read_snapshot` closure and returns the same watermark in header and
body (`bullet-kernel/apps/bullet-farmd/src/api.rs`, `leases.rs`,
`projections/`); the header/body cross-check is what lets the browser detect a
route that disagrees with itself.

## Composition: one shared watermark per view

`useProjection(title, load)` (`src/hooks/useProjection.ts`) runs `load` once
per mount and passes every `SnapshotRead` it produced to `atomicSnapshot`:

- no reads: `SNAPSHOT_WATERMARK_MISSING`;
- any `asOfSequence` differing from the first: `SNAPSHOT_WATERMARK_MISMATCH`;
- any `source` differing from the first: `SNAPSHOT_SOURCE_MISMATCH`;
- otherwise the view's `asOf` is the shared sequence and its `observedAt` is
  the latest of the reads.

Any thrown error — transport, schema, or watermark — becomes
`{kind: "unknown", text: "<Title>: control plane unreachable (<error>)",
source: "portal/local"}`, a local observation timestamped by the browser, and
the surface renders that text in the `unknown` class. `ProjectionCard`
(`src/components/ProjectionCard.tsx`) always prints the header line
`spec §N · as_of_sequence <n|unknown> · source <s|unknown> · observed_at
<t|unknown> · freshness <k>s since observed_at (one-shot snapshot, not live) ·
projection <loading|unknown|published> · confidence <published|unknown>`.
Projected surfaces do not subscribe to `/api/v1/events`; only Control Tower does
(`src/hooks/useEventStream.ts`), so a STALE badge there never silently
refreshes a one-shot projection and a projection never claims to be live.

## Counting and empty sets

- Catalog counts. `state_counts`, `intent_state_counts`, and `outcome_counts`
  are `LabelCount[]` built by the kernel's `count_labels`
  (`bullet-kernel/apps/bullet-farmd/src/projections/mod.rs`, called from
  `sessions.rs`, `merge_rail.rs`, `quality_lab.rs` with `AttemptState`,
  `EffectState::all()`, and the `GateOutcome` catalog): every catalog label is
  listed with an explicit count, zero included, and any observed label outside
  the catalog is appended rather than dropped. The portal renders those rows
  as-is through `COUNT_COLUMNS`; it never recomputes or hides a zero.
- Empty sets. `RowsTable` renders `<label>: 0 rows (verified at sequence N)`
  in the neutral `idle` class and `<label>: N rows (verified at sequence N)`
  above a table otherwise. Neither uses the green `verified` class;
  `e2e/fleet.spec.ts` and `e2e/real-farmd.spec.ts` assert `.verified` count 0
  on empty Fleet and Context Lineage projections.
- Nulls print their meaning, never blank: `contradictory: attempt row missing`
  (Fleet `attempt_state`), `unknown (no graph names it)` (Session Supervisor
  `mission_id`), `not recorded`, `none recorded`, `absent`, `not delivered`,
  `not acked`, `none` (`nullable(...)` in each page).
- Control Tower keeps its own vocabulary: `No missions yet.` and
  `outbox: empty (verified)` render only from an HTTP 200 JSON snapshot
  (`src/components/MissionsCard.tsx`, `OutboxCard.tsx`); a failed read is
  `unknown: control plane unreachable (…)` or `unknown: outbox unreachable (…)`.

## Surfaces that read farmd (9 of 15)

| Surface (`id`, spec) | Routes | DTO (`src/generated/api.ts`) | Component | Shown | Deliberately absent |
| --- | --- | --- | --- | --- | --- |
| Control Tower (`control-tower`, §25.1) | `GET /api/v1/missions`, `GET /api/v1/outbox`, `GET /health`, `GET /api/v1/events?after=<seq>`; `POST /api/v1/auth/bootstrap`, `POST /api/v1/commands`, `GET /api/v1/commands/{id}` | `Mission[]`, `OutboxView`, `Health`, `EventEnvelope`, `BootstrapResponse`, `CommandEnvelope`, `CommandStatus` | `src/pages/ControlTower.tsx` | `as_of_sequence`, projection lag from durable `Event.at`, stream state, `/health` probe, missions, outbox phases, the exact admitted command and its polled status; a bare durable `VERIFIED` is displayed as local `UNKNOWN` because generic `CommandStatus.result` cannot validate runtime Evidence and Effect receipts | green for any command until a generated runtime receipt contract binds the exact Candidate, independent Evidence, Effect receipt, and command id; any status that does not repeat the admitted id, kind, and payload digest; survival, cost, quota risk, and struggle (no ledger subject) |
| Mission Graph (`mission-graph`, §25.2) | `GET /api/v1/missions`, then `GET /api/v1/missions/{id}` per mission | `Mission[]`, `MissionView` (`mission`, `packages: WorkPackage[]`, `fence`) | `src/pages/ProjectedSurface.tsx` (`MissionGraph`) | raw JSON `{missions, graphs}` at the shared watermark | plan revisions, variants, attempts, candidates, evidence, and effects are not in `MissionView`; they appear only on Session Supervisor, Merge Rail, and Quality Lab |
| Live Attempt (`live-attempt`, §25.6) | as Mission Graph plus `GET /api/v1/ready` | `ReadyView` or `null`, `MissionView` | `src/pages/ProjectedSurface.tsx` (`LiveAttempt`) | raw JSON `{ready, graphs}`; `ready: null` is the empty queue at the watermark | session events, authority token hash, last-progress time: none is a ledger subject; `ReadyView` carries only ids, `title`, `enqueued_at` |
| Fleet (`fleet`, §25.5) | `GET /api/v1/fleet` | `FleetView` (`authority_time`, `leases: FleetLease[]`, `ready_queue: ReadyRow[]`) | `src/pages/FleetPage.tsx` | `authority_time` (store clock, liveness basis); per lease `liveness` live/expired/unknown judged by the kernel against that clock, fence, runner id and epoch, `heartbeat_at`, `expires_at`, `ttl_seconds`, linked attempt state, package, mission; ready queue | any browser-clock liveness judgement; runner host or process identity; a lease with no attempt row prints `contradictory: attempt row missing` rather than being hidden |
| Session Supervisor (`session-supervisor`, §25.7) | `GET /api/v1/sessions` | `SessionSupervisorView` (`attempts: AttemptRow[]`, `state_counts: LabelCount[]`) | `src/pages/SessionSupervisorPage.tsx` | attempts by `AttemptState` (every catalog label, zeros explicit); per attempt state, `lease` held/none, fence, variant, package, mission, runner id and epoch, `workspace_id`, scope/context revision, `leased_at`, `last_lease_event` (`attempt_leased`, `lease_expired`, `lease_released` with `seq` and `at`) | timestamps other than durable lease events — `AttemptRow` has no created, started, or finished time and the summary line says so; workspace dirty state, nonce, or preservation receipts (no such field in `AttemptRow`) |
| Context Lineage (`context-lineage`, §25.8) | `GET /api/v1/context-lineage` | `ContextLineageView` (`capsules: ContextCapsuleRow[]`) | `src/pages/ContextLineagePage.tsx` | immutable revision-one capsule id, mission/package/plan subjects, task class, exact schema, null initial parent, `compression: none`, zero dropped decisions, content/objective/title digests, `recorded_at` | raw objective/title; provider-created or successor capsules; non-null lineage edges; actual compression or dropped-decision history; the page explicitly says these are not claimed |
| Merge Rail (`merge-rail`, §25.13) | `GET /api/v1/merge-rail` | `MergeRailView` (`candidates: CandidateRow[]`, `intents: EffectIntentRow[]`, `receipts: EffectReceiptRow[]`, `effects: EffectRow[]`, `intent_state_counts`) | `src/pages/MergeRailPage.tsx` | exact candidates (`base_sha`, `head_sha`, `tree_sha`, `patch_digest`); effect intents by `EffectState` (every catalog label) and per intent target, `expected_old_oid`, `desired_state_hash`, fence, `policy_version`, `unknown_retries`; append-only receipts with `MATCH`/`MISMATCH`/`ABSENT` verdict, method, `adopted_after_unknown`; first-slice effects | forge state (refs, checks, merges): the portal never reads a forge; no integration result; if the `OUTCOME_UNKNOWN` label were missing from the counts the summary prints `unknown`, not 0 |
| Quality Lab (`quality-lab`, §25.14) | `GET /api/v1/quality-lab` | `QualityLabView` (`evidence: EvidenceRow[]`, `outcome_counts`) | `src/pages/QualityLabPage.tsx` | `GateOutcome` histogram (every catalog label, zeros explicit); per evidence row outcome, `satisfies_requirement`, tier, gate, stored result, candidate | evidence rows carry no verifier identity, no timestamp, and no artifact or log digest; only `satisfies_requirement === true` counts as PASS — `FLAKY`, `INFRA_ERROR`, `UNKNOWN`, and every other outcome never satisfy a requirement |
| Incidents & Audit (`incidents-audit`, §25.15) | `GET /api/v1/audit`, `GET /api/v1/outbox` | `AuditView` (`latest_sequence`, `tail_window`, `events: AuditEvent[]`), `OutboxView` | `src/pages/IncidentsAuditPage.tsx` | `latest_sequence`, `tail_window`, the newest contiguous events (`seq`, `at`, `kind`, stream, correlation, body), outbox rows with phase, delivered, acked | events older than the tail window (no paging); incident or contradiction rows (no ledger subject); a tail that is non-contiguous or does not end at `latest_sequence` fails validation and renders unknown |

## Surfaces without a farmd projection (6 of 15)

These surfaces have no `readSnapshot` route. `src/pages/SurfacePage.tsx`
renders `unknown: <Title>: <unknownReason>` in the `unknown` class under a
header of `as_of_sequence unknown · source none · observed_at unknown ·
freshness unknown · projection unknown · confidence unknown`. The reason text
below is the exact `unknownReason` from `src/surfaces.ts` (with
`NO_LEDGER_SUBJECT` expanded). The producing slices are in
`bullet-farm/docs/assurance/v1-closure-plan.md`: V1-S5 item 4 originally named
all seven as remaining work; this slice closes only initial Context Capsules,
leaving the six rows below. V1-S6 item 1 is "Persist typed Cognitive Tasks,
role/capability/profile snapshots, context capsules, behavior rules,
budget/quota reservations, routing provenance, struggle/escalation, fusion,
dissent, selection, and negative knowledge"; V1-S6 item 3 is hard-constraint
routing where "UNKNOWN paid capacity blocks ordinary dispatch"; V1-S4 item 2
is the heartbeat-failure path that "preserves the workspace, and permits a
successor fence to resume only from the exact checkpoint"; V1-S3 item 5
retains "the sealed preservation receipt". Initial Context Capsules are no
longer in this table; only the exact revision-one slice above is projected.

| Surface (`id`, spec) | Exact `unknownReason` | Producing slice |
| --- | --- | --- |
| Cognitive Router (`cognitive-router`, §25.3) | no ledger subject exists for this surface yet: routing decisions and their provenance (task taxonomy, hard exclusions, eligible lanes, quota shadow price, chosen tier, fallback ladder, calibration) are not persisted rows; produced by V1-S6 item 1 (persist typed Cognitive Tasks and routing provenance) and item 3 (hard-constraint routing) | V1-S6 items 1 and 3 |
| Fusion Lab (`fusion-lab`, §25.4) | no ledger subject exists for this surface yet: fusion protocol runs, contributor lanes, independent artifacts, ranker scores, and fuser provenance are not persisted rows; produced by V1-S6 item 1 (persist fusion, dissent, and selection) | V1-S6 item 1 |
| Quota and Capacity (`quota-capacity`, §25.9) | no ledger subject exists for this surface yet: budget/quota reservations and provider capacity observations are not persisted rows; produced by V1-S6 item 1 (persist budget/quota reservations) and item 3 (UNKNOWN paid capacity blocks ordinary dispatch) | V1-S6 items 1 and 3 |
| Struggle and Escalation (`struggle-cockpit`, §25.10) | no ledger subject exists for this surface yet: struggle scores, progress signatures, and escalation ladders are not persisted rows; produced by V1-S6 item 1 (persist struggle/escalation) | V1-S6 item 1 |
| Behavior Center (`behavior-center`, §25.11) | no ledger subject exists for this surface yet: behavior rule events, enforcement, and remediation receipts are not persisted rows (crates/behavior is a non-authoritative detector scaffold); produced by V1-S6 item 1 (persist behavior rules) | V1-S6 item 1 |
| Workspace and Git Hygiene (`workspace-hygiene`, §25.12) | no ledger subject exists for this surface yet: workspace dirty/untracked state, preservation receipts, and cleanup eligibility are not persisted rows (attempt rows carry only workspace_id, shown on Session Supervisor); produced by V1-S4 item 2 (preserve the workspace, resume from the exact checkpoint) and V1-S3 preservation receipts | V1-S4 item 2, V1-S3 item 5 |

## Where this is exercised

- Unit and component (`npm test`): `src/api.test.ts` (envelope, header, 404
  and null-ready rules), `src/apiValidation.test.ts`,
  `src/projectionValidation.test.ts`, `src/components/ProjectionCard.test.tsx`,
  and `src/pages/{ProjectedSurface,FleetPage,SessionSupervisorPage,ContextLineagePage,MergeRailPage,QualityLabPage,IncidentsAuditPage,SurfacePage}.test.tsx`.
- Mocked browser (`bash scripts/ci-local.sh contract`): `e2e/fleet.spec.ts`
  (4 tests: empty fleet renders zero rows never green; failed read renders
  unknown; liveness comes from the store clock; a header/body watermark
  contradiction renders unknown) and `e2e/control-tower.spec.ts` (6 tests,
  including "an unprojected surface names its missing ledger subject, not an
  empty success list").
- Real farmd (`bash ops/ci/real-farmd.sh`): `e2e/real-farmd.spec.ts` (3
  tests) checks against the built sibling `bullet-farmd` that legacy GET and a
  valid command POST under `/v1` return typed `API_VERSION_RETIRED` while the
  outbox body and watermark remain unchanged; that `/api/v1/fleet`,
  `/api/v1/sessions`, `/api/v1/context-lineage`, `/api/v1/merge-rail`, `/api/v1/quality-lab`,
  and `/api/v1/audit` answer
  with the `bullet-kernel/sqlite-ledger` source, matching header and body
  watermarks, and one shared watermark across all six; that empty Fleet and
  Context Lineage render verified zero-row observations with no
  `.verified` element; that Incidents & Audit shows `latest_sequence` equal to
  that watermark; that the real reconciled `UNKNOWN` command card has no green
  status; and that Quota and Capacity names its missing subject.
- Packaged farmd (`bash ops/ci/packaged-farmd.sh`): the three
  `e2e/real-farmd.spec.ts` live-farmd tests plus four mocked
  `e2e/shift-brief.spec.ts` routing/no-green tests, run against a
  `bullet-farmd` built with `--features embedded-portal` that serves this
  Portal's manifest-verified `dist` bytes at its own origin
  (`playwright.packaged.config.ts`, no preview server). The lane additionally
  requires `GET /health` to carry
  `portal: "<framed BLAKE3 bundle root>"` equal to this build's
  `.bullet-portal-bundle-v1.json` root, and `GET /` to serve the entry point.
  This is the projection contract proved under packaged serving; it is not a
  transaction, live-provider, or release proof.

## Packaged same-origin serving

In ordinary development the browser origin (`127.0.0.1:5173`) differs from
farmd's (`127.0.0.1:7420`) and Vite forwards `/api/v1`, `/health`, and
`/openapi.yaml`. The real-family lane asks farmd to bind an ephemeral loopback
port, validates the reported numeric origin, and supplies it only through
`BULLET_FARMD_TEST_PROXY`; non-loopback or malformed values refuse during the
build. In
the packaged lane there is one origin: farmd serves `index.html` and
`/assets/*` itself and `--portal-origin` equals that origin. The projection
contract is unchanged — one atomic snapshot per route, `x-bullet-as-of-sequence`
cross-checked against the body, one shared watermark per composed view — and so
is authority: same-origin does not relax the one-time bootstrap exchange, the
HttpOnly `SameSite=Strict` session cookie, the session-bound `X-Bullet-CSRF`
header, or farmd's exact-`Origin` refusal (`ORIGIN_REQUIRED`/`ORIGIN_DENIED`).
The built bundle uses only relative paths, which are same-origin by
construction. Vite refuses a nonempty `VITE_BULLET_API` before it can alter the
bundle subject.

## Parity checks

Run from the repository root. Expected values are stated for this Portal
change consuming Kernel `c3a7009`.

```bash
# Six unknown surfaces, exactly.
grep -c 'unknownReason:' src/surfaces.ts          # 6
grep -c '^  "' src/pages/ProjectedSurface.tsx      # 8 members of PROJECTED_SURFACES

# The generated prefix is the sole operator-namespace constant consumed by both clients.
grep -F 'export const API_PREFIX = "/api/v1";' src/generated/api.ts
grep -F 'import { API_PREFIX } from "./generated/api";' src/api.ts
grep -F 'import { API_PREFIX } from "../generated/api";' src/hooks/useEventStream.ts
grep -oE '\$\{API_PREFIX\}/[a-z/-]+' src/api.ts | sort -u
grep -oE '\$\{API_PREFIX\}/events' src/hooks/useEventStream.ts | sort -u
```

The first grep must print 6; the second lists the eight projected ids. The
route greps must print the `${API_PREFIX}` suffixes for `audit`,
`auth/bootstrap`, `commands`, `commands/`, `context-lineage`, `fleet`,
`merge-rail`, `missions`, `missions/`, `outbox`, `quality-lab`, `ready`,
`sessions`, and `events`. With the generated prefix expanded and the two
parameterized suffixes completed, each corresponding `/api/v1` route appears
in the tables above and in `docs/architecture.md`; `/health` remains the one
intentional non-versioned read.
