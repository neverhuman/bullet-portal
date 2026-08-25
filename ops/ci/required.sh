#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "required lane: fast + mocked Playwright + real farmd Playwright"
bash ops/ci/fast.sh
log "required lane: Portal bundle manifest contracts"
npm run bundle:typecheck
npm run bundle:test
bash ops/ci/contract.sh
bash ops/ci/real-farmd.sh
log "required lane: exact final Portal bundle subject"
npm run bundle:generate
npm run bundle:check
log "required lane passed"
