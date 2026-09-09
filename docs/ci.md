# Continuous integration

Status: prepared, not hosted authority
Owner: Bullet Farm maintainers
Last reviewed: 2026-08-25

Portal CI is forge-neutral at the command boundary. The five atomic lanes are
`bash scripts/ci-local.sh fast|lint|contract|security|docs`; local `required`
runs those five sequentially, exactly once. The real sibling-farmd browser
proof is deliberately separate as `bash scripts/ci-local.sh family`. A Portal
checkout can therefore prove itself without a sibling repository, while the
family orchestrator has one explicit place to supply an immutable Kernel.

## Hosted mirror definition

`.github/workflows/ci.yml` prepares secretless `pull_request`, `push`, and
`merge_group` jobs on `ubuntu-24.04`. The five lanes run in parallel and the
exact context `CI / required` converges them with `if: always()`. Its executable
aggregator rejects failed, skipped, cancelled, or missing jobs and missing
observations. Superseded cancellation applies only to pull requests; pushes and
merge-group runs have unique concurrency keys. Checkout credentials are never
persisted, workflow permissions are `contents: read`, actions are full-SHA
pinned, and no cache is written.

The event and permission choices follow GitHub's documentation for
[workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
and [secure use](https://docs.github.com/en/actions/reference/security/secure-use).

Node is pinned to 22.23.2 and npm to 10.9.8. A dependency-free source and
lockfile scan runs before any dependency installation. Installation uses
`npm ci --ignore-scripts`; the Chromium lifecycle is a separate reviewed
Playwright step. The security lane then runs gitleaks 8.21.2 over the current
tree, proves a disposable secret-shaped canary is rejected, runs the full npm
audit, and runs zizmor 1.25.2. The lint lane requires actionlint 1.7.8 and
ShellCheck 0.10.0.

The full-history scan has one exact fingerprint ignore for the historical
non-secret `CSRF_STORAGE_KEY` name at commit `3f651ad`; current source was
renamed to `CSRF_STORAGE_SLOT` in `696ee0d`. No rule or path is allowlisted,
and both the current-tree scan and the disposable detector canary remain
mandatory.

`.github/workflows/scheduled.yml` prepares weekly full-history secret scanning,
external-link checking, the full dependency audit, coverage ratchets, and
`macos-15`/`windows-2025` compile-and-test jobs. The portable jobs must also
produce and validate the typed `PORTAL_PROJECTION_ONLY` refusal; they cannot
skip unsupported mutation and report green.

These workflow bytes are not proof of a hosted run. No mirror URL, ruleset, or
required-context API read-back has been ratified in this repository, so no CI
badge or hosted-evidence claim is made. Activation requires two completed main
pushes, a merge-group run that reports the exact `CI / required` context, a
fork-PR permission read-back, and branch-protection read-back.

## Jeryu preparation

`ci.toml` declares the same five local commands and a dependency convergence
job. Each atomic job uses `ops/ci/jeryu-lane.sh` to invoke its local lane,
emit one unsigned lane observation, sanitize it, and expose only the named
observation and diagnostic paths. Every prepared job first runs
`ops/ci/jeryu-activation-gate.sh`, which returns typed
`JERYU_CI_ACTIVATION_BLOCKED` (exit 78). The convergence command also refuses
when invoked directly because predecessor status and artifact binding remain
unratified. The proposed
`native-node-clean` profile, immutable subject provisioning, artifact handling,
and required-context read-back are not ratified. Removing the gate or enabling
a runner is an operator/forge action, not a documentation change. `Family /
required` must not exist until schema-3 supplies authenticated repository URLs
and immutable OIDs and the complete family order is proved.

## Diagnostics, not Evidence

Hosted lane artifacts contain normalized test reports, coverage when scheduled,
and `bullet.ci-observation.v1` JSON. Each observation binds the repository
commit/tree, cleanliness, command, tool versions, lane outcome, and hashes of
relative diagnostic paths. It is unsigned and carries
`evidence_class: DIAGNOSTIC_ONLY`; it is neither Bullet Evidence nor a release
receipt. An artifact redaction scan runs before upload, and raw bootstrap tokens,
worker tokens, provider credentials, and credential-bearing logs are never
uploaded.
