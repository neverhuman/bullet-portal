# Changelog

All notable changes to bullet-portal are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project is
pre-release: there is no published version, tag or artifact, and no released
heading may be added before the gates in `docs/release.md` hold with receipts.

## [Unreleased]

### Added

- Jankurai control plane for this component: `agent/audit-policy.toml`,
  `agent/boundaries.toml`, `agent/proof-lanes.toml`,
  `agent/security-policy.toml` and `agent/tool-adoption.toml`. The audit report
  now carries a real `policy_fingerprint` instead of `sha256:0000…`.
- `tools/security-lane.sh`, the canonical security-lane wrapper that delegates
  to `ops/ci/security.sh` and names the tools the lane runs.
- `scripts/ci-doctor.sh`, the local environment check for every lane.
- `ops/git-hooks/pre-push`, the mandatory local pre-push gate
  (`git config core.hooksPath ops/git-hooks`).
- `docs/testing.md` (lanes, artifacts, repair routing, budgets and stop
  conditions, and the known gaps) and `docs/release.md` (fail-closed release
  contract), plus this changelog.

### Changed

- `agent/generated-zones.toml` now declares a reproducible `command` for both
  generated zones.
- `agent/JANKURAI_STANDARD.md` now documents the typed `ApiError` surface —
  purpose, the kernel's stable reason code, common fixes, repair hint and docs
  route — so a failure routes a repair without reading a log.

### Removed

- `agent/zyal/`: a ZYAL v1 runbook is a `RUN_FOREVER` daemon envelope and the
  Portal has no run-forever agent loop, so the three-line stub was not a runbook
  and was removed rather than faked into one.

[Unreleased]: https://github.com/bullet-farm/bullet-portal
