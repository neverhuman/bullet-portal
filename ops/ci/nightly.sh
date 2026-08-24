#!/usr/bin/env bash
# Offline real-process proof: a locally built farmd plus the portal in a browser.
# Requires the sibling bullet-kernel checkout; its absence fails closed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "nightly lane"
bash ops/ci/real-farmd.sh
log "nightly lane passed"
