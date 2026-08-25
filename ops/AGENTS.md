# bullet-portal operations

CI entrypoints live in `ops/ci/<lane>.sh`. They are exposed only through
`bash scripts/ci-local.sh <lane>` and the matching `just` recipe, and
`.github/workflows/ci.yml` calls the same scripts. Change a lane by changing
its script; never add logic to the workflow or the Justfile that the script
does not run.

## Lanes

| Lane | Script | Runs | Prerequisites |
| --- | --- | --- | --- |
| fast | `ops/ci/fast.sh` | `tsc --noEmit`, `npm test` (vitest, jsdom), `npm run build` | Node 22 (hosted pin), `npm ci` |
| contract | `ops/ci/contract.sh` | `playwright test` with `playwright.config.ts`: `e2e/` minus `real-farmd.spec.ts`, mocked routes, Vite dev server on `127.0.0.1:5173` (`reuseExistingServer: true`) | Playwright Chromium (`just setup`; hosted `playwright install --with-deps chromium`) |
| real-farmd | `ops/ci/real-farmd.sh` | `npm run build`; `cargo build --locked -p bullet-farmd` in the sibling `../bullet-kernel`; starts `target/debug/bullet-farmd` on `127.0.0.1:7420` with `--portal-origin http://127.0.0.1:5173` and a `umask 077` worker-token file in a temp dir; waits for `/health`; extracts the one-time `boot_…` token from farmd's log; `npm run preview` on `127.0.0.1:5173 --strictPort` (`playwright.real.config.ts`, `reuseExistingServer: false`); `e2e/real-farmd.spec.ts` | sibling `bullet-kernel` checkout containing `Cargo.toml`, Rust toolchain, `curl`, Chromium; ports 7420 and 5173 free |
| required | `ops/ci/required.sh` | fast → `npm run bundle:typecheck` → `npm run bundle:test` → contract → real-farmd → `npm run bundle:generate` → `npm run bundle:check` | everything above |
| security | `ops/ci/security.sh` | `gitleaks detect --no-git --redact`, `npm audit --omit=dev` | `gitleaks` (hosted: 8.21.2, sha256-pinned download), `package-lock.json` present |
| audit | `ops/ci/audit.sh` | `jankurai audit --fail-under $AUDIT_FLOOR --fail-on critical`, artifacts in `.jankurai/` | `jankurai`; local/release only, not in `ci.yml` |
| nightly | `ops/ci/nightly.sh` | `ops/ci/real-farmd.sh` again | same as real-farmd; no hosted schedule |
| packaged-farmd | `ops/ci/packaged-farmd.sh` | `npm run build`; `npm run bundle:generate` + `bundle:check` (both refuse `DIRTY_SOURCE`); `cargo build --locked -p bullet-farmd --features embedded-portal` with `BULLET_PORTAL_DIST=$REPO_ROOT/dist` in the sibling `../bullet-kernel`; starts that farmd on `127.0.0.1:7421` (`BULLET_PACKAGED_PORT` overrides) with `--portal-origin http://127.0.0.1:7421` and a `umask 077` worker-token file; requires `/health` to carry the exact manifest root and `/` to serve the entry point; runs `e2e/real-farmd.spec.ts` through `playwright.packaged.config.ts` with **no** web server of its own | sibling `bullet-kernel` checkout, Rust toolchain, `curl`, `node`, Chromium; port 7421 free; a **clean** Portal source tree, because the bundle manifest binds an exact commit |

## Rules

- The packaged-farmd lane has exactly one neutral outcome: an absent sibling
  `bullet-kernel` checkout exits 78 without running anything. It is additive —
  `required` still fails closed through `ops/ci/real-farmd.sh` — so a neutral
  packaged lane never turns a missing real-process proof green. Every other
  packaged failure (dirty source, manifest drift, a `/health` that does not
  name this exact bundle root, a missing entry point, a bad bootstrap token) is
  fatal.
- Never skip-green. A missing tool (`require_tool` in `ops/ci/lib.sh`), a
  missing sibling Kernel, a farmd that never answers `/health`, a bootstrap
  token that does not match `^boot_[0-9a-f]{64}$`, or a missing audit artifact
  exits non-zero. Do not add `|| true`, `continue-on-error`, mock fallbacks, or
  environment switches that let a real-process lane report success without
  running the real process.
- Generated files are never hand-edited: `src/generated/` (kernel and hub
  contract copies, `agent/generated-zones.toml`), `dist/` (build output), and
  the bundle manifest `.bullet-portal-bundle-v1.json` (`npm run
  bundle:generate`; `npm run bundle:check` refuses drift). `.jankurai/` files
  are lane outputs.
- `AUDIT_FLOOR` in `ops/ci/audit.sh` is a ratchet: it may only rise.
- Secrets in the real-farmd lane: the bootstrap token is read from farmd's log
  into an environment variable and never printed; the worker token is a fixed
  test value written to a mode-0600 file in a `mktemp -d` directory; farmd is
  killed and the directory removed by the `EXIT` trap. Never log either token,
  never reuse an already running farmd, never point the browser at `:7420`
  directly (same-origin proxy only).
- Hosted `ci.yml`: every third-party action is pinned to a full commit SHA,
  `persist-credentials: false`, `permissions: contents: read`. Keep it thin;
  it must run exactly the scripts here.
- No worktrees, no commits, no forge mutation, and no Jeryu access from any
  lane. Lanes read the canonical checkout and the sibling Kernel checkout only.
- Tool pins to keep in step: Node 22 (`ci.yml`), `@playwright/test` and
  Chromium from `package-lock.json`, gitleaks 8.21.2 (`ci.yml` sha256),
  `jankurai` for the audit lane.
