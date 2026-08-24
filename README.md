# bullet-portal

Operations portal for Bullet Farm. Projection only — the browser holds no
authority: every view names its observation source, and UNKNOWN is rendered
as unknown, never as healthy and never as an authoritative empty list. Agents start at
[`AGENTS.md`](AGENTS.md).

Control Tower snapshot/SSE recovery, authenticated public command submission,
and navigation are tested in unit and browser lanes. Mission Graph, Live
Attempt, and Incidents & Audit read the generated `/v1/missions/{id}` and
`/v1/ready` projections and refuse to render when their watermarks disagree;
the remaining spec §25 surfaces have no farmd projection and render explicitly
UNKNOWN. The portal has no signed runner authority, forge, holdout, integration,
or command-worker path, and it does not establish a five-plane transaction or
production-readiness claim.

The operator pastes farmd's one-time CLI bootstrap into a password input. Farmd
returns an HttpOnly/SameSite browser session and a session-bound CSRF value;
only then can the browser submit a fresh idempotent `run_demo` envelope to
`POST /v1/commands`. The Portal polls `GET /v1/commands/{id}` and renders only
durable `VERIFIED` green. `PENDING` and `APPLIED` remain amber, while transport
ambiguity and durable `UNKNOWN` remain unknown. The current daemon has no
authenticated command worker, so a newly admitted real command honestly
remains `PENDING`.

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
(`src/api.ts`). `npm run preview` has no API proxy, and farmd does not grant
cross-origin browser authority. A functional preview must therefore serve the
built assets behind a same-origin reverse proxy that forwards `/v1`, `/health`,
and `/openapi.yaml` to farmd. Pointing a browser bundle directly at
`http://127.0.0.1:7420` is not a supported workaround.

## Lanes

`just setup` installs dependencies and the Playwright Chromium build the
browser lanes need.

| Lane | Command | Contents |
| --- | --- | --- |
| fast | `just fast` | tsc, vitest (unit + component, jsdom), production build |
| required | `just check` | fast plus focused mocked projection/SSE Playwright and a locally built sibling farmd authenticated-command E2E; missing sibling Kernel fails closed |
| contract | `just contract` | Playwright against mocked projection/SSE routes (`playwright.config.ts`); command mutation mocks stay in component tests |
| security | `just security` | gitleaks (no-git) plus `npm audit --omit=dev`; a missing tool fails |
| audit | `bash ops/ci/audit.sh` | Jankurai audit against a committed ratchet floor; artifacts under `.jankurai/` |
| nightly | `bash ops/ci/nightly.sh` | repeats the real-process farmd/browser proof outside required; fails closed without the sibling Kernel |

`.github/workflows` runs these scripts. Runners must provide `gitleaks` and
`jankurai`; required and nightly additionally need the exact sibling family
checkout, a Rust toolchain, and Chromium. Standalone hosted provisioning of
that pinned Kernel subject is not yet registered, so hosted required is not
release evidence and fails closed rather than substituting mocks.
