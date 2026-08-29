# bullet-portal

Operations portal for Bullet Farm. Projection only — the browser holds no
authority: every view names its observation source, and UNKNOWN is rendered
as unknown, never as healthy and never as an authoritative empty list. Agents start at
[`AGENTS.md`](AGENTS.md).

Control Tower snapshot/SSE recovery, authenticated command submission, and
navigation are tested in unit and browser lanes. Nine of the fifteen spec §25
surfaces read farmd through the atomic snapshot contract in
[`docs/projections.md`](docs/projections.md): Control Tower (`/api/v1/missions`,
`/api/v1/outbox`, `/health`, `/api/v1/events`), Mission Graph and Live Attempt
(`/api/v1/missions`, `/api/v1/missions/{id}`, and for Live Attempt `/api/v1/ready`),
Fleet (`/api/v1/fleet`), Session Supervisor (`/api/v1/sessions`), Context Lineage
(`/api/v1/context-lineage`), Merge Rail (`/api/v1/merge-rail`), Quality Lab
(`/api/v1/quality-lab`), and Incidents & Audit
(`/api/v1/audit`, `/api/v1/outbox`). Composed reads refuse to render when their
watermarks disagree. Context Lineage publishes only immutable revision-one
capsule subjects and digests; it does not expose raw objective/title or claim
successor/compression lineage. The other six surfaces — Cognitive Router,
Fusion Lab, Quota and Capacity, Struggle and Escalation, Behavior Center, and
Workspace and Git Hygiene — have no farmd projection and render explicitly
UNKNOWN with the missing ledger subject named (`src/surfaces.ts`). The portal
has no signed runner authority, forge, holdout, integration, or command-worker
path, and it does not establish a five-plane transaction or
production-readiness claim.

The operator pastes farmd's one-time CLI bootstrap into a password input. Farmd
returns an HttpOnly/SameSite browser session and a session-bound CSRF value;
only then can the browser submit a fresh idempotent `run_demo` envelope to
`POST /api/v1/commands`. The Portal polls `GET /api/v1/commands/{id}`. `PENDING`
and `APPLIED` remain amber, while transport ambiguity and durable `UNKNOWN`
remain unknown. The wire vocabulary includes `VERIFIED`, but its current
`CommandStatus.result` is generic JSON and cannot validate the required exact
Candidate, independent Evidence, Effect receipt, and command correlation. A
bare `VERIFIED` status therefore displays as local `UNKNOWN`, its unverified
result is discarded, and no command path is green. Farmd has no dispatch,
APPLIED, or VERIFIED path: a newly admitted real command stays `PENDING` until farmd's
worker-token `POST /internal/v1/commands/{id}/reconcile` settles it, and the
only settlement it produces today is `UNKNOWN` (`EXECUTION_ADAPTER_UNAVAILABLE`),
which `e2e/real-farmd.spec.ts` shows the browser rendering as unknown, never
green.

## Quick start

```bash
just fast          # tsc + vitest + production build
npm run dev        # http://127.0.0.1:5173
```

Run `just setup` first only when this checkout has not yet run dependency
preparation.

The dev server proxies `/api/v1`, `/health`, and `/openapi.yaml` to
`http://127.0.0.1:7420` (bullet-farmd). Browser requests remain same-origin
through that proxy. `VITE_BULLET_API` is unsupported: Vite configuration
refuses any nonempty override before serving or building.

## Build and preview

`src/api.ts` uses an immutable empty API prefix, so every request is relative
to the bundle origin. A nonempty `VITE_BULLET_API` makes Vite fail with typed
`VITE_BULLET_API_UNSUPPORTED`; it is never baked into the bundle. The
loopback-only `npm run preview` proof server serves the built `dist` bytes and
proxies only `/api/v1`, `/health`, and `/openapi.yaml` to loopback farmd. It is a
CI/developer preview boundary, not the release server; the packaged Rust
distribution must embed the same built bytes.
Pointing a browser bundle directly at `http://127.0.0.1:7420` is not supported.

`npm run bundle:generate` writes the exact `dist` bundle manifest
(`.bullet-portal-bundle-v1.json`: every emitted file with size, MIME type, and
BLAKE3 digest, the `package-lock.json` digest, source and tool subjects, and a
framed BLAKE3 root); `npm run bundle:check` refuses any drift from it. Both are
`ops/build/portal-bundle.ts`, typechecked by `npm run bundle:typecheck` and
tested by `npm run bundle:test`.

## Packaged serving

A packaged Bullet Farm ships no Vite server. `bullet-farmd` built with its
`embedded-portal` cargo feature and `BULLET_PORTAL_DIST=<absolute dist>`
compiles these exact built bytes in: its build script re-derives this
manifest's canonical body, framed BLAKE3 root, and every file digest, and
refuses the build on any drift, extra entry, symlink, or dirty-source subject.
That daemon then serves `/`, `/index.html`, and `/assets/*` from its own
origin — content-hashed assets `immutable`, `index.html` no-store — so
`--portal-origin` equals the daemon origin and the browser is same-origin
without a proxy. Nothing about authority changes: the one-time bootstrap,
the HttpOnly `SameSite=Strict` session cookie, the session-bound CSRF header,
and the exact-Origin check all still apply, and `GET /health` gains a `portal`
field naming the embedded bundle root (absent when no Portal is embedded).

`bash ops/ci/packaged-farmd.sh` (`just packaged-farmd`) proves it end to end:
it builds `dist`, binds the manifest, builds that farmd from the sibling
Kernel, checks `/health` names this exact bundle root, and runs
the three `e2e/real-farmd.spec.ts` cases plus the four mocked
`e2e/shift-brief.spec.ts` routing/no-green cases against the daemon's own
origin through `playwright.packaged.config.ts`. It is a packaged-origin
projection/bundle component proof, not a transaction, live-provider, or release
proof, and is not part of standalone `required`.

## Lanes

`just setup` installs dependencies and the Playwright Chromium build the
browser lanes need. Every recipe delegates to `bash scripts/ci-local.sh <lane>`,
which runs `ops/ci/<lane>.sh`; the rules for editing those scripts are in
[`ops/AGENTS.md`](ops/AGENTS.md).

| Lane | Command | Contents |
| --- | --- | --- |
| fast | `just fast` | Vitest unit/component tests with a nonzero/all-pass report, then the typed production build |
| lint | `just lint` | actionlint 1.7.8, ShellCheck 0.10.0, and whitespace checks |
| contract | `just contract` | bundle generator type/tests plus 14 mocked Playwright projection/SSE tests; `real-farmd.spec.ts` is excluded and a nonzero/all-pass JUnit report is required |
| security | `just security` | gitleaks 8.21.2 current-tree scan and must-fail canary, the full npm audit, and zizmor 1.25.2 |
| docs | `just docs` | relative links, workflow structure, test-partition inventory, and negative aggregator meta-tests |
| required | `just check` | fast → lint → contract → security → docs, sequentially and exactly once; no sibling repository |
| family | `just family` | explicit Linux-only real-farmd browser proof against the sibling Kernel; missing provisioning fails closed |
| audit | `bash ops/ci/audit.sh` | Jankurai audit against the committed ratchet floor (`AUDIT_FLOOR=59`, may only rise); artifacts under `.jankurai/` |
| nightly | `bash ops/ci/nightly.sh` | compatibility alias for the explicit family lane |
| packaged-farmd | `just packaged-farmd` | `ops/ci/packaged-farmd.sh`: builds `dist`, runs `npm run bundle:generate`/`bundle:check` (refuses on a dirty source tree), builds the sibling Kernel's `bullet-farmd` with `--features embedded-portal` and `BULLET_PORTAL_DIST=$PWD/dist`, starts it on `127.0.0.1:7421` with `--portal-origin http://127.0.0.1:7421`, requires `/health` to name that exact bundle root and `/` to serve the entry point, then runs `e2e/real-farmd.spec.ts` (3 live-farmd tests) and `e2e/shift-brief.spec.ts` (4 mocked routing/no-green tests) through `playwright.packaged.config.ts` against the daemon's own origin with no preview server. Exits neutral 78 only when the sibling Kernel checkout is absent; every other failure is fatal |

The prepared mirror workflow runs the five atomic jobs in parallel on
`ubuntu-24.04` and converges them at the exact `CI / required` context with an
`if: always()` fail-closed aggregator. It uses Node 22.23.2, npm 10.9.8,
secretless checkouts, full-SHA action pins, no caches, and
`npm ci --ignore-scripts`; Playwright's browser install is separate. Scheduled
definitions add history/link/audit/coverage and macOS/Windows typed-refusal
proofs. No hosted run or protection read-back exists yet, so these definitions
are diagnostics, not release evidence. See [`docs/ci.md`](docs/ci.md).
