#!/usr/bin/env bash
# Security lane: secret scan plus production dependency audit. Missing tools fail closed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "security lane"
require_tool gitleaks || exit 1
[[ -f package-lock.json ]] || { echo "[ci] package-lock.json missing" >&2; exit 1; }
gitleaks detect --source . --no-git --redact --no-banner
npm audit --omit=dev
log "security lane passed"
