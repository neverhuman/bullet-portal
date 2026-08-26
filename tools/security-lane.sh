#!/usr/bin/env bash
# Canonical security-lane wrapper for bullet-portal.
#
# The executable lane is ops/ci/security.sh; this wrapper is the stable entry
# point that names the tools the lane runs so a reader does not have to
# reconstruct them from the workflow. It adds no policy of its own and never
# downgrades a failure: it execs the lane and inherits its exit code.
#
# Tools, all fail-closed. A missing tool exits non-zero through `require_tool`
# and a wrong version is refused outright, so a missing or unpinned scanner can
# never produce a green lane:
#   gitleaks detect --source . --no-git --redact --no-banner   (gitleaks 8.21.2)
#   bash ops/ci/secret-canary.sh   (plants a detector-shaped credential and
#     fails the lane if gitleaks accepts it, so a broken detector cannot look
#     like a clean tree)
#   npm audit                      (whole dependency graph, dev included)
#   zizmor --offline --no-ignores --strict-collection .
#                                  (zizmor 1.25.2, committed workflow bytes)
# The lane also refuses if src/api.ts loses `CSRF_STORAGE_SLOT` or regresses to
# the key-shaped `CSRF_STORAGE_KEY` identifier.
#
# Declared in agent/security-policy.toml. Do not add `|| true` to any step.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$repo_root/ops/ci/security.sh"
