#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "required lane: tsc + vitest"
bash ops/ci/fast.sh
log "required lane passed"
