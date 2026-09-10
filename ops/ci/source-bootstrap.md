# Source proof bootstrap

The existing `scripts/ci-local.sh` remains the only proof coordinator. It requires
Linux live monitoring and a prepared monitor before any stage starts. Missing
prerequisites are non-passing. Hosted policy observations are diagnostic evidence;
they do not grant provider, publication, signing or operator authority.

Local canonical proofs use `BULLET_CI_SOURCE_ADMISSION` and its `_SHA256` variable.
The `bullet.source-admission.v1` packet binds exact source HEAD/tree, all selected
tools and complete input roots, reviewed explicit output exclusions, the prepared
monitor build and actual writer grant/release records. Its independent
`bullet.source-admission-review.v1` receipt binds SHA256 of compact JSON for the
admission object without its `review` reference. It is not inferred from CI green
status or a prior receipt file.

For a hosted ephemeral Linux runner, the wrapper can generate the dynamic packet
without a new human act. Provide these path and `_SHA256` pairs:

- `BULLET_CI_SOURCE_POLICY`: reviewed `source-policy.json`.
- `BULLET_CI_SOURCE_POLICY_REVIEW`: independent static review described below.
- `BULLET_CI_SOURCE_TOOL_PROFILE`: admitted exact tool and input profile.
- `BULLET_CI_SOURCE_MONITOR_BUILD`: prepared monitor build record.

Also provide `BULLET_CI_SOURCE_MONITOR_BIN`. Standard GitHub Actions run, event,
workspace, job, runner-environment and `RUNNER_TEMP` fields must be present.
Every same-UID process must belong to the current control ancestry or exact owned
monitor; an unreleased background process refuses. This is a cooperative ephemeral
runner policy, not cryptographic runner attestation or hostile same-UID isolation.
Canonical SSH work does not acquire a writer release by setting environment flags.

The tool profile has schema `bullet.source-tool-profile.v1`, `platform: "linux"`,
`inputs_complete: true`, `tools_complete: true`, and these inventories:

- `tools`: unique name, executable SHA256, `version_args`, and exact
  `version_first_line` under `LC_ALL=C`. Include every command used by the lane.
- `input_roots`: complete canonical external tool/dependency/configuration roots;
  `$CHECKOUT` expands to the selected checkout. A private PATH directory is added
  and every selected tool is hash-bound. Root completeness needs independent review.
- `outputs`: relative checkout path and reason for each exact output subtree.
  `.ci-artifacts` must be explicit. Tracked paths and Git metadata cannot be excluded.
- `monitor`: `executable_sha256`, all eight `{name, sha256}` source entries, and
  exactly cargo/rustc `{name, sha256}` build tool entries.

The independent static receipt uses `bullet.source-policy-review.v1`, verdict
`accepted`, actual reviewer identity, `policy_sha256`, `tool_profile_sha256`, and
`evaluator_sources` entries `{name, sha256}` for `source-policy.mjs`,
`source-bootstrap.mjs`, and `source-custody.mjs`. A changed evaluator or profile
requires a new independent review. Runtime-generated evaluation receipts name this
static policy; they never impersonate a human review of a dynamic checkout.

The prepared build uses `bullet.source-monitor.build.v1`, `executable_sha256`,
`source_root`, `sources: [{path, sha256}]`, and `tools: [{name, path, sha256}]`.
Source names are Cargo.toml, Cargo.lock, README.md, src/main.rs, src/common.rs,
src/monitor.rs, src/protocol.rs and src/operations.rs. Automatic admission accepts
an independently pinned external monitor bundle while the entire PR checkout is
still monitored. This permits testing unreviewed PR changes with a previously
admitted monitor. A self-declared matching executable/build pair is insufficient.

Bootstrap records live process/run/source identities, observed tool versions and
an explicit `bullet.source-policy-evaluation.v1` receipt under a private external
runner temporary directory. READY repeats policy, monitor, tool-selection, raw
tracked-byte and writer checks after watches are installed. Later current-source
reuse invokes the hash-bound Rust inventory verifier. The exact ephemeral
`.git/bullet-ci.lock.d` tree is the only additional reuse exclusion.

The custody regression route executes both the existing hostile ownership tests
and `source-custody-test.mjs`/`source-policy-test.mjs`. It requires explicit
`BULLET_CI_SOURCE_MONITOR_BIN`, `BULLET_CI_SOURCE_RUSTC`, and
`BULLET_CI_SOURCE_CARGO`. Synthetic review/profile records in these tests are
labelled diagnostic and provide no canonical writer release. Native macOS and
Windows custody and actual hosted policy execution remain separate qualifications.
