#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "required lane: fast + mocked Playwright + real farmd Playwright"
bash ops/ci/fast.sh
bash ops/ci/contract.sh
bash ops/ci/real-farmd.sh
log "required lane passed"
