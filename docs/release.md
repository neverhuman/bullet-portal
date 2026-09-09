# Release contract

Status: **no release exists; every release gate is BLOCKED**
Owner: bullet-portal maintainers (`agent/owner-map.json`)
Last reviewed: 2026-08-25
Applies to: bullet-portal

This page is a fail-closed contract, not a plan of record. Nothing here has been
released, and no lane in `ops/ci/` may publish, tag, mirror, sign, or otherwise
mutate forge state. A green component lane is never a release.

## Version source

`package.json` carries the version and `package-lock.json` the locked graph;
every CI install uses `npm ci`. `agent/standard-version.toml` binds the
standard, paper, auditor and schema versions this component claims. There is no
published package, tag or artifact, so there is no version to consume yet.

## Change record

`CHANGELOG.md` carries the unreleased change record. It may never gain a
released version heading before the gates below hold with receipts.

## Launch gate inventory

A release gate closes only with an artifact-backed receipt from an independent
checker. Today every gate is BLOCKED. The honest status of each:

| Release gate | Required evidence | Status |
| --- | --- | --- |
| Component proof | `bash scripts/ci-local.sh required` green on the release commit | available locally; `npm run bundle:generate` refuses on a dirty tree by design, so this lane can only be green from a committed subject |
| Conformance score | `bash ops/ci/audit.sh` at or above the upward-only `AUDIT_FLOOR` ratchet | local gate only: the pinned auditor is a machine-local build and is not registered in hosted CI |
| Secret and dependency scan | `bash scripts/ci-local.sh security`: `gitleaks detect`, `npm audit`, `zizmor --offline --no-ignores --strict-collection .` | runs and fails closed; it produces no release artifact |
| Integrity and provenance | checksum, signature and SBOM for a published bundle | BLOCKED: nothing is built for publication. The Portal bundle carries a content digest for the kernel to serve, which is integrity evidence for an embed, not for a release |
| Backup and restore | a restore drill | not applicable in the usual sense: the Portal holds no durable truth. Its state is the kernel's, and the kernel's backup and restore contract is `bullet-kernel/docs/release.md`. Browser-local state is per-viewer and disposable |
| Rollback | a rehearsed rollback procedure | BLOCKED: rollback means serving the previous embedded bundle from the kernel, and no versioned bundle history exists to roll back to |
| Monitoring | telemetry, dashboards and alerts | BLOCKED: none exist. What exists is a typed `ApiError` with the kernel's stable reason code and `request_id`, and a rendered surface that shows staleness and `UNKNOWN` instead of hiding them |
| Abuse and rate limits | a rate-limited authenticated surface | the Portal enforces none and must not: it is a projection. Rate limiting and authorization belong to the kernel; the Portal renders a refusal as a refusal |
| Rendered UX QA | a layered rendered UX QA lane | BLOCKED: Playwright proves the rendered surface, but the layered lane does not exist (`docs/testing.md`, "Known gaps") |

## Rules

- Release builds depend on immutable tags, not branches.
- Lanes never publish, mirror, tag, push, or touch Jeryu.
- A skipped, missing, flaky or `UNKNOWN` result is never success, and exit 78 is
  not green (`docs/testing.md`).
- Never hand-edit `src/generated/` to make a build pass; regenerate it.
