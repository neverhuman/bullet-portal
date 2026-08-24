#!/usr/bin/env bash
# Mocked e2e. No live farmd and no live models.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "contract lane: playwright against mocked API"
./node_modules/.bin/playwright test
log "contract lane passed"
