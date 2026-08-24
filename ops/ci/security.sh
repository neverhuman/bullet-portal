#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "security lane"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --no-git --redact
else
  log "gitleaks not installed; skip (install for hosted CI)"
fi
if [[ -f package-lock.json ]]; then
  npm audit --omit=dev || log "npm audit reported issues (non-blocking until lock is gated)"
fi
log "security lane finished"
