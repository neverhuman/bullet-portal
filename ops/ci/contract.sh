#!/usr/bin/env bash
# Portable bundle contracts. Rendered browser proof is an xbabe2-local lane.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor
reports="$(artifact_dir reports)"
log "contract lane: portable bundle contracts"
{
  npm run bundle:typecheck
  npm run bundle:test
} 2>&1 | tee "$reports/bundle-tests.log"
node ops/ci/bundle-report.mjs "$reports/bundle-tests.log"
log "contract lane passed"
