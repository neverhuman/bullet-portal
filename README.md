# bullet-portal

Operations portal for Bullet Farm. Projection only — the browser holds no
authority: every view names its observation source, and UNKNOWN is rendered
as unknown, never as healthy and never as an authoritative empty list.

Current status is component-level only. Control Tower snapshot/SSE recovery and navigation are
tested; surfaces without a covering generated projection remain explicitly UNKNOWN. The portal has
no signed-authority, credential, forge, holdout, or integration path, and it does not establish a
five-plane transaction or production-readiness claim.

## Develop

```bash
npm install
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

## Test lanes

```bash
npm test                        # vitest: unit + component (jsdom)
npm run e2e                     # playwright against mocked routes
bash scripts/ci-local.sh fast   # tsc + vitest + vite build (required lane)
```
