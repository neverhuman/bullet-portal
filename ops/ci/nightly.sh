#!/usr/bin/env bash
# Compatibility alias for the explicit family lane.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "nightly lane"
bash ops/ci/family.sh
log "nightly lane passed"
