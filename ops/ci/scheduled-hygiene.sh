#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor
require_tool gitleaks || exit 1
[[ "$(gitleaks version)" == "8.21.2" ]] || {
  echo "[ci] gitleaks 8.21.2 required" >&2
  exit 1
}

log "scheduled hygiene: full-history secrets + full dependency audit + external links"
gitleaks git . --log-opts=--all --redact --no-banner
npm audit
node ops/ci/external-links.mjs
log "scheduled hygiene passed"
