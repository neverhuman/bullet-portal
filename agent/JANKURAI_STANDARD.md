# Jankurai Standard Binding

bullet-portal is a browser projection of the bullet-kernel API. It is never an
authority source. The machine-readable half of this binding is
`agent/standard-version.toml`, `agent/owner-map.json`, `agent/test-map.json`,
`agent/proof-lanes.toml`, `agent/generated-zones.toml`, `agent/boundaries.toml`,
`agent/security-policy.toml`, `agent/tool-adoption.toml` and
`agent/audit-policy.toml`.

## Hard rules

- No secrets in the browser and no handwritten wire DTOs. Generated DTOs,
  runtime schemas, and `API_PREFIX` live only in `src/generated/`, a
  `generator_only` zone (`agent/generated-zones.toml`). JSON request/response
  and SSE transports remain handwritten in `src/api.ts`, `src/apiValidation.ts`,
  `src/sse.ts`, and `src/hooks/useEventStream.ts`; they must validate generated
  subjects fail-closed and must not be called generated clients. Transport
  generation and its drift contract remain an explicit product gap.
- Rendered UX must prove pending versus verified, and show unknown as unknown.
  An ambiguous result is rendered `UNKNOWN`; it is never resolved into success.
- Split files before 500 LOC; prefer under 300.
- `AUDIT_FLOOR` in `ops/ci/audit.sh` is an upward-only ratchet.
- Never skip-green: a missing tool, a skipped case, or a neutral exit 78 is
  never success (`ops/AGENTS.md`).

## Repair receipts and the agent-friendly exception surface

Every failure that crosses the kernel boundary becomes one typed value,
`ApiError` in `src/api.ts`, so a failure routes a repair instead of printing a
string. The contract it satisfies:

- **purpose** — say which request refused and where: `ApiError` carries the
  method, the URL and the HTTP status alongside the message.
- **reason** — `ApiError.code` is the kernel's stable machine reason code,
  copied through unchanged from the RFC 9457 problem body. It is a wire
  contract: `SNAPSHOT_WATERMARK_MISMATCH`, `STALE_AUTHORITY` and
  `LIVE_ADMISSION_UNAVAILABLE` mean the same thing here as they do in
  bullet-kernel, so the Portal never renames or re-maps one. `code` is `null`
  only when the failure happened before a problem body existed (transport,
  schema validation, a missing watermark header), and those cases carry an
  explicit detail instead.
- **common fixes** — the message keeps the kernel's own `Repair:` field and its
  `request_id`, so the operator repeats the exact server-side repair rather than
  guessing. A schema-validation failure means the generated DTO/schema subject
  or handwritten validator/transport is behind the kernel contract: regenerate
  `src/generated/` and rerun the contract lane. A
  watermark mismatch means the snapshot and the stream disagree; reload the
  projection rather than adopting either half.
- **repair_hint** — the lane that reproduces the failure locally: rendering and
  projection failures with `bash scripts/ci-local.sh fast`, generated-client
  drift with `bash scripts/ci-local.sh contract`, secret and dependency findings
  with `bash scripts/ci-local.sh security`, whole-surface regressions with
  `bash scripts/ci-local.sh required`, and score regressions with
  `bash scripts/ci-local.sh audit`.
- **docs_url** — `docs/testing.md` for lanes and artifacts,
  `docs/projections.md` for what a surface is allowed to claim, and
  `docs/architecture.md` for the boundary itself.

The rerun command and the artifact it writes are the repair receipt: the audit
lane leaves `.jankurai/repo-score.json` and `.jankurai/repo-score.md`, and a
rerun of the named lane is the evidence that a repair landed.

## No ZYAL runbooks live here

A ZYAL v1 runbook is a `RUN_FOREVER` daemon envelope. The Portal has no
run-forever agent loop, so its proof surface is `agent/proof-lanes.toml` and the
`ops/ci/<lane>.sh` scripts instead. The previous `agent/zyal/fast.zyal` was a
three-line stub that was not a ZYAL envelope at all; it was removed rather than
dressed up into a fake envelope to satisfy a checker.

## Accepted audit exceptions

Exceptions are declared where the auditor reads them, never as a silent
suppression: `agent/audit-policy.toml` (`[dead_language] allow_terms`, with the
justification for each term next to it). A wire-contract string is never renamed
to satisfy a marker rule.
