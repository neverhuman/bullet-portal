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
| contract | `bash scripts/ci-local.sh contract` | portable bundle typecheck and all five bundle tests, with actual output retained in the sealed observation. |
| rendered | `bash scripts/ci-local.sh rendered` | all 24 mocked Playwright cases with the same exact identity digest and zero-failure report checks, locally on xbabe2 only. |
| security | `bash scripts/ci-local.sh security` | `gitleaks detect`, a detector canary that fails the lane if gitleaks accepts a planted credential, the `CSRF_STORAGE_SLOT` symbol guard, `npm audit`, and `zizmor --offline --no-ignores --strict-collection .`. Wrapper: `tools/security-lane.sh`; policy and pins: `agent/security-policy.toml`. |
| docs | `bash scripts/ci-local.sh docs` | local documentation links resolve, and the CI structure and meta-loss controls hold. |
| required | `bash scripts/ci-local.sh required` | the canonical local merge gate: fast, lint, contract, security and docs, sequentially and exactly once, each with an observation record. |
| family | `bash scripts/ci-local.sh family` | all three real sibling-farmd browser cases, locally on xbabe2 only, outside standalone `required`. |
| packaged-farmd | `bash scripts/ci-local.sh packaged-farmd` | all seven browser cases against a packaged farmd serving this Portal, locally on xbabe2 only. Exit 78 without the sibling checkout. |
| coverage | `bash scripts/ci-local.sh coverage` | the unit and component suites with a ratcheted coverage summary over `src`, excluding tests and the generated zone. |
| portable | `bash scripts/ci-local.sh portable` | the fast lane plus a recorded and re-checked typed platform refusal, so a non-Linux host refuses in a named way instead of silently passing. |
| scheduled-hygiene | `bash scripts/ci-local.sh scheduled-hygiene` | full-history secret scan, full dependency audit, and external link resolution. Scheduled; never a merge gate. |
| audit | `bash scripts/ci-local.sh audit` | the Jankurai score against the upward-only `AUDIT_FLOOR` ratchet. |

## Artifacts and repair routing

All Tuiwright and Playwright execution belongs on the Linux development host
`xbabe2`, with `CI` and `GITHUB_ACTIONS` absent. This includes mocked browser
cases. Other hosts and CI contexts refuse `RENDERED_HOST_REQUIRED` before
starting a browser or proof daemon. `just setup` installs portable dependencies;
`just setup-rendered` provisions Chromium after this local-host check.
Hosted CI runs the five portable required lanes. Fresh local rendered, family
and packaged results are additional integration requirements; hosted green
does not establish those results or authenticated native-provider completion.

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

The current unit partition contains 360 distinct passing identities, pinned by
count and SHA-256 in both fast and coverage lanes. This includes navigation,
atomic operator snapshots, ordinary event refresh and durable session consumers.
Command-history tests cover owned discovery after local cache loss,
pagination, stale responses, phase regression and exact HTTP status validation.
Retry coverage also checks Rust-compatible request digests, exact settled-command
responses, journal serialization and subject substitution, and browser reloads
that retain the original envelope without an automatic POST.
Task-intent tests cover the closed v2 payload, UTF-8 and path bounds,
exact decimal budgets, the real form builder and pre-POST journal, restored
intent conflicts, owned snapshot correlation and refresh refusal. Fresh tasks
carry repository/base, scope, criteria, gates, dependencies, budget and deadline;
the UI displays the recorded scheduling blocker without claiming execution.
A count is never inferred from prior runs: the JSON report must
contain every expected passing identity with zero skipped, pending or failed
cases. Browser fixtures and local HTTP tests remain component proofs; they do
not establish the installed provider workflow or release acceptance.

## Conversation and owner recovery

The conversation journal commits exact prepared requests to IndexedDB before
POST. Settlement retains a durable draft-to-command relationship, including
after detach/reload, while historical reconciliation keeps its original
identity and receipt. Archived FAILED/UNKNOWN rows remain discoverable; PENDING
rows keep their reservation. Bounded message-range read-back settles a receipt
before an independent visible-window refresh, including sequences beyond 10,000.
Loaded windows, drafts and selection survive ordinary refresh, including an
explicit New conversation selection. Historical reconciliation retains any
unrelated active reservation. Saved history exposes validated local outcome
observations in bounded pages, retaining original receipts and contradictions
without treating them as execution or integration authority.

Every repaired projection and SSE opening uses the selected session header and
checks the server acknowledgement before consuming data or absence. Authentication
changes cancel old generations and clear displayed data; a delayed refusal cannot
clear a newer authenticated selection. The operator/origin-scoped coding journal
retains exact request bytes across same-operator reauthentication. Unowned legacy
records remain private until an owner-filtered exact command read succeeds.
Even an acknowledged absence cannot authorize adoption of legacy bytes.

The 24-case mocked rendered partition retains the original 14 projection/SSE
cases and adds ten real-browser IndexedDB conversation cases. Portable tests
also exercise storage rollback, two-tab contention, completion selectors,
archived recovery, stale owners, missing acknowledgements, migration write/remove
failure, historical retries, input composition and bounded pagination. These
synthetic faults do not qualify a live Head, production providers, installation,
independent integration, manual accessibility or the performance targets.

## Authenticated connected browser proof

The family and packaged lanes share the three real-daemon cases in
[`real-farmd.spec.ts`](../e2e/real-farmd.spec.ts). One admitted browser context
survives ordinary reloads. Anonymous projections, command discovery and SSE
must refuse with `SESSION_REQUIRED`; an authenticated component submission is
rediscovered from command history without a local submission journal.
[`real-worker.ts`](../e2e/real-worker.ts) retains the exact sealed claim,
binary manifest, preservation receipt, durable `UNKNOWN` result and restart
assertions. Fixture execution is Node-side and cannot establish provider work.

Both modes build in a fresh private target and require an explicitly selected,
canonical, protected `BULLET_GITD_BIN` with matching `BULLET_GITD_SHA256`.
Packaged mode also verifies the clean-source bundle, embeds it in farmd and
checks the served bundle root and entry point. It uses the same component
worker, peer registry and private receipt custody as the forwarded lane.
Thirty build-admission fixtures exercise both modes. The launcher's bootstrap,
worker-token and lease-key files are removed on exit. Raw worker output, JUnit,
browser diagnostics, daemon logs and ambiguous worker state remain in the
private proof directory. Repository reports contain only its location, exit
status and explicit component eligibility limits, never replacement success
results. The lane validates the original private JUnit report.
Browser tracing, screenshots and video are disabled for these credential-bearing
component tests. The retained fixture is neither an installation nor a recording
of live provider execution.

## Never skip-green

A missing tool, a wrong tool version, a skipped case, a flaky rerun, or an
ambiguous result is never success. A lane that cannot run its check fails; it
does not reduce itself to the checks that happen to be available. Two controls
exist specifically to stop a quiet pass: the security lane plants a
detector-shaped credential and fails if gitleaks accepts it, and the fast,
rendered and coverage lanes assert an exact test count so an empty or truncated
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
publish, tag, or mutate remote state. `scheduled-hygiene` uses the network
outside merge gates; `security` and `required` also need network access for
the dependency audit. A lane
that would need the network to pass is not made green by skipping the network
step.

## Known gaps

- There is no layered rendered UX QA lane yet. Playwright proves the rendered
  surface, but the auditor's `missing-rendered-ux-qa-lane` cap stands, and it is
  recorded here rather than declared satisfied.
- The Jankurai audit runs locally only. The pinned auditor is a machine-local
  build, so no workflow may claim it ran; adding a hosted job that silently
  skipped would be a false green.
- Authenticated Head Playwright and Tuiwright are not hosted and are not the
  24-identity mocked rendered suite. A future `playwright.head.config.ts` is
  invoked only by Hub `just xbabe2-head` on xbabe2; off-node and CI exit 78
  with `XBABE2_PROVIDER_PROOF_UNAVAILABLE`. Family and packaged farmd
  Playwright remain fixture/`UNKNOWN` proofs, not a provider-authenticated
  Head. Kernel `vt100` child-process TUI tests are the cheap default and are
  not Tuiwright. Do not add Head Playwright or Tuiwright to
  `.github/workflows`.
