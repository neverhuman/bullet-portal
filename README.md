# bullet-portal

Operations portal for Bullet Farm. Projection only — the browser holds no
authority: every view names its observation source, and UNKNOWN is rendered
as unknown, never as healthy and never as an authoritative empty list. Agents start at
[`AGENTS.md`](AGENTS.md).

Control Tower snapshot/SSE recovery, authenticated command submission, and
navigation are tested in unit and browser lanes. Nine of the fifteen spec §25
surfaces read farmd through the atomic snapshot contract in
[`docs/projections.md`](docs/projections.md): Control Tower (`/v1/missions`,
`/v1/outbox`, `/health`, `/v1/events`), Mission Graph and Live Attempt
(`/v1/missions`, `/v1/missions/{id}`, and for Live Attempt `/v1/ready`),
Fleet (`/v1/fleet`), Session Supervisor (`/v1/sessions`), Context Lineage
(`/v1/context-lineage`), Merge Rail (`/v1/merge-rail`), Quality Lab
(`/v1/quality-lab`), and Incidents & Audit
(`/v1/audit`, `/v1/outbox`). Composed reads refuse to render when their
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
`POST /v1/commands`. The Portal polls `GET /v1/commands/{id}` and renders only
durable `VERIFIED` green. `PENDING` and `APPLIED` remain amber, while transport
ambiguity and durable `UNKNOWN` remain unknown. Farmd has no dispatch, APPLIED,
or VERIFIED path: a newly admitted real command stays `PENDING` until farmd's
worker-token `POST /internal/v1/commands/{id}/reconcile` settles it, and the
only settlement it produces today is `UNKNOWN` (`EXECUTION_ADAPTER_UNAVAILABLE`),
which `e2e/real-farmd.spec.ts` shows the browser rendering as unknown, never
green.

## Quick start

```bash
just setup
just fast          # tsc + vitest + production build
npm run dev        # http://127.0.0.1:5173
```

The dev server proxies `/v1`, `/health`, and `/openapi.yaml` to
`http://127.0.0.1:7420` (bullet-farmd). Keep `VITE_BULLET_API` unset during
development so browser requests remain same-origin through that proxy. The
hub's `just portal` launcher enforces this rule.

## Build and preview

`VITE_BULLET_API` is read at build time and baked into the bundle
(`src/api.ts`). The loopback-only `npm run preview` proof server serves the
built `dist` bytes and proxies only `/v1`, `/health`, and `/openapi.yaml`
to loopback farmd. It is a CI/developer preview boundary, not the release
server; the packaged Rust distribution must embed the same built bytes.
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
`e2e/real-farmd.spec.ts` against the daemon's own origin through
`playwright.packaged.config.ts`. The lane is additive to `required`, which
still proves the proxied `ops/ci/real-farmd.sh` path unchanged.

## Lanes

`just setup` installs dependencies and the Playwright Chromium build the
browser lanes need. Every recipe delegates to `bash scripts/ci-local.sh <lane>`,
which runs `ops/ci/<lane>.sh`; the rules for editing those scripts are in
[`ops/AGENTS.md`](ops/AGENTS.md).

| Lane | Command | Contents |
| --- | --- | --- |
| fast | `just fast` | `ops/ci/fast.sh`: `tsc --noEmit`, `npm test` (vitest unit + component, jsdom), `npm run build` |
| contract | `just contract` | `ops/ci/contract.sh`: Playwright (`playwright.config.ts`, Vite dev server) against mocked projection/SSE routes — `e2e/control-tower.spec.ts` (6 tests) and `e2e/fleet.spec.ts` (4 tests); `real-farmd.spec.ts` is excluded; command mutation mocks stay in component tests |
| real-farmd | `bash ops/ci/real-farmd.sh` | builds `dist`; requires the sibling `../bullet-kernel` checkout and runs `cargo build --locked -p bullet-farmd` there; starts that farmd on `127.0.0.1:7420` with a worker-token file, reads its one-time bootstrap from the log without printing it, serves `dist` through `npm run preview`, and runs `e2e/real-farmd.spec.ts` (2 tests, `playwright.real.config.ts`): command `PENDING` → worker reconcile → `UNKNOWN` never green, and six list projections answering from one shared watermark with empty Fleet and Context Lineage rendered as zero rows, not green |
| required | `just check` | `ops/ci/required.sh`: fast, then `npm run bundle:typecheck` and `npm run bundle:test`, then contract, then real-farmd, then `npm run bundle:generate` and `npm run bundle:check`; a missing sibling Kernel fails closed |
| security | `just security` | gitleaks (no-git) plus `npm audit --omit=dev`; a missing tool fails |
| audit | `bash ops/ci/audit.sh` | Jankurai audit against the committed ratchet floor (`AUDIT_FLOOR=59`, may only rise); artifacts under `.jankurai/` |
| nightly | `bash ops/ci/nightly.sh` | runs `ops/ci/real-farmd.sh` again outside required; fails closed without the sibling Kernel; no hosted schedule is registered |
| packaged-farmd | `just packaged-farmd` | `ops/ci/packaged-farmd.sh`: builds `dist`, runs `npm run bundle:generate`/`bundle:check` (refuses on a dirty source tree), builds the sibling Kernel's `bullet-farmd` with `--features embedded-portal` and `BULLET_PORTAL_DIST=$PWD/dist`, starts it on `127.0.0.1:7421` with `--portal-origin http://127.0.0.1:7421`, requires `/health` to name that exact bundle root and `/` to serve the entry point, then runs `e2e/real-farmd.spec.ts` (2 tests, `playwright.packaged.config.ts`) against the daemon's own origin with no preview server. Exits neutral 78 only when the sibling Kernel checkout is absent; every other failure is fatal |

`.github/workflows/ci.yml` runs the fast, required, contract, and security
scripts unchanged on Node 22 with Playwright Chromium (`--with-deps`) and a
checksum-pinned gitleaks 8.21.2; audit and nightly are local-only lanes. Local
runners must provide `gitleaks` and `jankurai` themselves. Required and
nightly additionally need the exact sibling family checkout, a Rust
toolchain, and Chromium. Standalone hosted provisioning of that pinned Kernel
subject is not registered, so hosted required is not release evidence and
fails closed rather than substituting mocks.
