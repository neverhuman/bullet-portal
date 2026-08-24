#!/usr/bin/env bash
# Offline real-process proof: local farmd plus the portal in a browser.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "nightly lane"
bash ops/ci/real-farmd.sh
log "nightly lane passed"
