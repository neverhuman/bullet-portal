#!/usr/bin/env bash
# Live farmd+SimHarness e2e later. Skip when the stack is not up.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "nightly lane"
if [[ -z "${BULLET_LIVE_PORTAL:-}" ]]; then
  log "BULLET_LIVE_PORTAL unset; skip live farmd e2e"
  exit 0
fi
log "live portal requested; farmd+SimHarness e2e not implemented yet"
exit 0
