#!/usr/bin/env bash
# Explicit family-only lane. This is intentionally absent from standalone required.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' '{"code":"FAMILY_MUTATION_LINUX_ONLY","status":"REFUSED"}' >&2
  exit 78
fi
log "family lane: real sibling farmd browser proof"
bash ops/ci/real-farmd.sh
log "family lane passed"
