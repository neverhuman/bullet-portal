# Testing

Every lane is `bash ops/ci/<lane>.sh`, reachable as
`bash scripts/ci-local.sh <lane>` and as a `just` recipe, and declared in
`agent/proof-lanes.toml`. `docs/ci.md` describes how those lanes are wired into
hosted CI; this page is the local view: what each lane proves, what it leaves
behind, and how a finding routes back to a rerun. `bash scripts/ci-doctor.sh
<lane>` reports whether this machine has the tools a lane needs before you spend
a run.

| Lane | Command | What it proves |
| --- | --- | --- |
| fast | `bash scripts/ci-local.sh fast` | vitest with an asserted case count plus the typed production build. Standalone: it never resolves a sibling repository. This is the pre-push gate (`ops/git-hooks/pre-push`). |
| lint | `bash scripts/ci-local.sh lint` | actionlint over the workflows, ShellCheck over every `ops/ci` and `scripts` shell file, and `git diff --check`. Discovering zero shell files fails the lane rather than passing empty. |
| contract | `bash scripts/ci-local.sh contract` | the bundle typecheck and tests plus the mocked Playwright suite with an asserted case count. No live farmd, no live models. |
| security | `bash scripts/ci-local.sh security` | `gitleaks detect`, a detector canary that fails the lane if gitleaks accepts a planted credential, the `CSRF_STORAGE_SLOT` symbol guard, `npm audit`, and `zizmor --offline --no-ignores --strict-collection .`. Wrapper: `tools/security-lane.sh`; policy and pins: `agent/security-policy.toml`. |
| docs | `bash scripts/ci-local.sh docs` | local documentation links resolve, and the CI structure and meta-loss controls hold. |
| required | `bash scripts/ci-local.sh required` | the canonical local merge gate: fast, lint, contract, security and docs, sequentially and exactly once, each with an observation record. |
| family | `bash scripts/ci-local.sh family` | the real sibling-farmd browser proof, deliberately outside standalone `required`. Off Linux it refuses with `FAMILY_MUTATION_LINUX_ONLY` and exit 78. |
| packaged-farmd | `bash scripts/ci-local.sh packaged-farmd` | a browser proof against a packaged farmd that serves this Portal. Exit 78 without the sibling checkout. |
| coverage | `bash scripts/ci-local.sh coverage` | the unit and component suites with a ratcheted coverage summary over `src`, excluding tests and the generated zone. |
| portable | `bash scripts/ci-local.sh portable` | the fast lane plus a recorded and re-checked typed platform refusal, so a non-Linux host refuses in a named way instead of silently passing. |
| scheduled-hygiene | `bash scripts/ci-local.sh scheduled-hygiene` | full-history secret scan, full dependency audit, and external link resolution. Scheduled; never a merge gate. |
| audit | `bash scripts/ci-local.sh audit` | the Jankurai score against the upward-only `AUDIT_FLOOR` ratchet. |

## Artifacts and repair routing

The lanes write their evidence under the CI artifact directory: vitest and
Playwright reports with asserted case counts, the coverage summary, the recorded
platform refusal, and per-lane observation records. The audit lane writes
`.jankurai/repo-score.json` and `.jankurai/repo-score.md`.

Those artifacts plus the rerun command in the table above are the repair receipt
for a finding: rerun the named lane and its artifact is the evidence that the
repair landed. `agent/test-map.json` routes an owned path to its lane, and
`agent/JANKURAI_STANDARD.md` describes the typed `ApiError` surface — its
purpose, the kernel's stable reason code, the common fixes for each, the repair
hint, and where each one is documented.

## Never skip-green

A missing tool, a wrong tool version, a skipped case, a flaky rerun, or an
ambiguous result is never success. A lane that cannot run its check fails; it
does not reduce itself to the checks that happen to be available. Two controls
exist specifically to stop a quiet pass: the security lane plants a
detector-shaped credential and fails if gitleaks accepts it, and the fast,
contract and coverage lanes assert an exact test count so an empty or truncated
run cannot look green. Exit 78 is neutral, never green — it means the lane was
not registered on this host, and it may not be counted as a pass. An ambiguous
kernel response is rendered `UNKNOWN` in the UI and asserted as `UNKNOWN` in the
tests; it is never adopted as a result.

## Budgets and stop conditions

The Portal calls no provider, model, or metered API, so there is no spend to
bound and `agent/audit-policy.toml` declares `cost_surface = []`. What is
bounded is time and scope: the fast lane is browser-free so it stays in seconds;
Playwright runs against a mocked or local farmd and never against a remote
environment; `npm ci --ignore-scripts` is the install form, so a dependency
cannot run an install script in a proof lane; and no lane may reach a forge,
publish, tag, or mutate remote state. The one lane that is allowed to use the
network, `scheduled-hygiene`, is scheduled and is never a merge gate. A lane
that would need the network to pass is not made green by skipping the network
step.

## Known gaps

- There is no layered rendered UX QA lane yet. Playwright proves the rendered
  surface, but the auditor's `missing-rendered-ux-qa-lane` cap stands, and it is
  recorded here rather than declared satisfied.
- The Jankurai audit runs locally only. The pinned auditor is a machine-local
  build, so no workflow may claim it ran; adding a hosted job that silently
  skipped would be a false green.
