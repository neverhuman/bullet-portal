#!/usr/bin/env bash
# Security lane: secret scan, production dependency audit, and workflow policy
# scan. Every step fails closed; a missing tool fails the lane.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "security lane"
require_tool gitleaks || exit 1
require_tool zizmor || exit 1
[[ -f package-lock.json ]] || { echo "[ci] package-lock.json missing" >&2; exit 1; }
gitleaks detect --source . --no-git --redact --no-banner
npm audit --omit=dev
# zizmor audits the committed workflow bytes. Without a GitHub API token it
# reports that it is skipping its five online audits (impostor-commit,
# ref-confusion, known-vulnerable-actions, stale-action-refs,
# ref-version-mismatch); the offline audits still fail the lane on a finding.
zizmor .
log "security lane passed"
