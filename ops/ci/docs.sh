#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor

log "docs lane: local links + CI structure/meta-loss controls"
bash ops/ci/toolchain-test.sh
node ops/ci/docs.mjs
node ops/ci/meta.mjs
node ops/ci/aggregate-test.mjs
log "docs lane passed"
