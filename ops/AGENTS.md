# bullet-portal operations

CI entrypoints live in `ops/ci/<lane>.sh`. They are exposed through
`bash scripts/ci-local.sh <lane>` and matching `just` recipes. Hosted
definitions call those same entrypoints; workflows may provision pinned tools,
emit observations, sanitize artifacts, and converge outcomes, but may not
reimplement a lane.

## Standalone lanes

| Lane | Contents | Required tools |
| --- | --- | --- |
| fast | Vitest JSON report with nonzero/all-pass guard; typed Vite production build | Node 22.23.2, npm 10.9.8, locked dependencies |
| lint | actionlint, ShellCheck, whitespace | actionlint 1.7.8, ShellCheck 0.10.0 |
| contract | bundle type/tests; exact five passing Node TAP identities | Node 22.23.2, npm 10.9.8, locked dependencies |
| security | current-tree gitleaks, must-fail disposable canary, full npm audit, zizmor | Node 22.23.2, npm 10.9.8, gitleaks 8.21.2, zizmor 1.25.2 |
| docs | relative-link checker, workflow/config meta-tests, negative aggregator fixtures | Node 22.23.2, npm 10.9.8 |
| required | fast → lint → contract → security → docs exactly once | all of the above |

`required` is genuinely standalone. It must never resolve `../bullet-kernel`,
run `real-farmd.sh`, or generate a clean-source release bundle manifest.

## Family and scheduled lanes

All Tuiwright and Playwright execution, including mocked cases, runs locally
on `xbabe2`/Linux with `CI` and `GITHUB_ACTIONS` absent. The `rendered` lane
retains all 24 mocked cases and their exact JUnit identity check. `family`
retains the three real-farmd browser cases. It fails closed
when the sibling Kernel is absent. `packaged-farmd` remains the clean-source
embedded-bundle proof; its sole neutral 78 is an absent sibling checkout.
`nightly` is a compatibility alias for `family`.

`coverage`, `scheduled-hygiene`, and `portable` are scheduled diagnostics.
Portable macOS/Windows runs compile and test the Portal and must validate the
typed `PORTAL_PROJECTION_ONLY` mutation refusal. Linux is the only platform on
which a family mutation-capable proof may run.

## Hosted controls

- Mirror CI is secretless: `contents: read`, checkout
  `persist-credentials: false`, no `pull_request_target`, and no cache.
- Required triggers have no path filters and include `pull_request`, `push`,
  and `merge_group`. Only pull requests are cancelled when superseded.
- Use `ubuntu-24.04`, Node 22.23.2, npm 10.9.8, and full action SHAs.
- Run `ops/ci/preinstall-scan.mjs` before dependency or tool installation.
  Use `npm ci --ignore-scripts`. Browser installation and execution belong to
  the guarded local `setup-rendered`/`rendered` entries, outside hosted CI.
- The exact `CI / required` aggregator uses `if: always()` and rejects every
  failed, skipped, cancelled, missing, zero-test, or observation-less partition.
- Observations conform to `bullet.ci-observation.v1`, remain unsigned
  `DIAGNOSTIC_ONLY`, and contain no timestamps or logs. Sanitize before upload;
  never upload bootstrap/worker tokens or raw credential-bearing traces.
- `ci.toml` is prepared but not active. Its gate must remain a typed
  `JERYU_CI_ACTIVATION_BLOCKED` refusal until runner, immutable-subject, and
  required-context read-back are ratified.

## Boundary rules

- Generated files are never hand-edited: `src/generated/`, `dist/`, and
  `.bullet-portal-bundle-v1.json`.
- No workflow or standalone lane gains authority. The browser remains a
  projection and UNKNOWN remains unknown.
- Only `real-farmd.sh` and `packaged-farmd.sh` may resolve the sibling Kernel.
  They must clean child processes and temporary credential files on every exit.
- No worktrees, commits, remotes, releases, rulesets, runner activation, or
  external publication from these scripts.
