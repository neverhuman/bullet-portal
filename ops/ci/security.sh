#!/usr/bin/env bash
# Security lane: current-tree secret scan, detector canary, full dependency
# audit, and workflow policy scan. Every step fails closed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor
log "security lane"
require_tool gitleaks || exit 1
require_tool zizmor || exit 1
[[ "$(gitleaks version)" == "8.21.2" ]] || {
  echo "[ci] gitleaks 8.21.2 required" >&2
  exit 1
}
[[ "$(zizmor --version)" == "zizmor 1.25.2" ]] || {
  echo "[ci] zizmor 1.25.2 required" >&2
  exit 1
}
[[ -f package-lock.json ]] || { echo "[ci] package-lock.json missing" >&2; exit 1; }
gitleaks detect --source . --no-git --redact --no-banner
grep -Fq 'const CSRF_STORAGE_SLOT' src/api.ts || {
  echo "[ci] expected non-secret CSRF storage symbol is absent" >&2
  exit 1
}
if grep -Fq 'CSRF_STORAGE_KEY' src/api.ts; then
  echo "[ci] secret-like CSRF storage identifier regressed" >&2
  exit 1
fi
bash ops/ci/secret-canary.sh
npm audit
# zizmor audits the committed workflow bytes without consulting GitHub. The
# explicit offline mode makes the audit set deterministic; ignored findings
# and incomplete collection both fail the lane.
zizmor --offline --no-ignores --strict-collection .
log "security lane passed"
