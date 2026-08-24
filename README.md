# bullet-portal

Operations portal for Bullet Farm. Projection only — the browser holds no
authority: every view names its observation source, and UNKNOWN is rendered
as unknown, never as healthy and never as an authoritative empty list. Agents start at
[`AGENTS.md`](AGENTS.md).

Current status is component-level only. Control Tower snapshot/SSE recovery and navigation are
tested in unit and browser lanes. Mission Graph, Live Attempt, and Incidents & Audit read the
generated `/v1/missions/{id}` and `/v1/ready` projections and refuse to render when their
watermarks disagree; the remaining spec §25 surfaces have no farmd projection and render
explicitly UNKNOWN. The portal has no signed-authority, credential, forge, holdout, or
integration path, and it does not establish a five-plane transaction or production-readiness
claim.

The current Run button calls `POST /v1/demo/run` directly. There is no public
`/v1/commands` ledger, browser session, or CSRF boundary yet, so its local
pending/receipt display is component behavior and not durable command or
transaction evidence.

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
| required | `just check` | fast plus mocked Playwright and a locally built sibling farmd real-process E2E; missing sibling Kernel fails closed |
| contract | `just contract` | Playwright against mocked farmd routes (`playwright.config.ts`) |
| security | `just security` | gitleaks (no-git) plus `npm audit --omit=dev`; a missing tool fails |
| audit | `bash ops/ci/audit.sh` | Jankurai audit against a committed ratchet floor; artifacts under `.jankurai/` |
| nightly | `bash ops/ci/nightly.sh` | repeats the real-process farmd/browser proof outside required; fails closed without the sibling Kernel |

`.github/workflows` runs these scripts. Runners must provide `gitleaks` and
`jankurai`; required and nightly additionally need the exact sibling family
checkout, a Rust toolchain, and Chromium. Standalone hosted provisioning of
that pinned Kernel subject is not yet registered, so hosted required is not
release evidence and fails closed rather than substituting mocks.
