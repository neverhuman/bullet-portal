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

## Quick start

```bash
just setup
just fast          # tsc + vitest + production build
npm run dev        # http://127.0.0.1:5173
```

The dev server proxies `/v1`, `/health`, and `/openapi.yaml` to
`http://127.0.0.1:7420` (bullet-farmd), so `VITE_BULLET_API` may stay unset
during development.

## Build and preview

`VITE_BULLET_API` is read at build time and baked into the bundle
(`src/api.ts`). `npm run preview` serves the built bundle without the dev
proxy, so the variable is required there:

```bash
VITE_BULLET_API=http://127.0.0.1:7420 npm run build
npm run preview
```

Unset, requests go same-origin — correct behind the dev proxy or a reverse
proxy that forwards `/v1` and `/health` to farmd.

## Lanes

`just setup` installs dependencies and the Playwright Chromium build the
browser lanes need.

| Lane | Command | Contents |
| --- | --- | --- |
| fast | `just fast` | tsc, vitest (unit + component, jsdom), production build |
| required | `just check` | the fast lane |
| contract | `just contract` | Playwright against mocked farmd routes (`playwright.config.ts`) |
| security | `just security` | gitleaks (no-git) plus `npm audit --omit=dev`; a missing tool fails |
| audit | `bash ops/ci/audit.sh` | Jankurai audit against a committed ratchet floor; artifacts under `.jankurai/` |
| nightly | `bash ops/ci/nightly.sh` | builds farmd from the sibling `../bullet-kernel` checkout and runs `e2e/real-farmd.spec.ts` against it (`playwright.real.config.ts`); fails closed without the sibling |

`.github/workflows` runs exactly these scripts. Runners must provide
`gitleaks` and `jankurai`; the nightly lane additionally needs the family
checkout and a Rust toolchain.
