#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
owner="${BULLET_CI_OBSERVATION_OWNER:-}"
unset BULLET_CI_OBSERVATION_OWNER
observation_operation() {
  BULLET_CI_OBSERVATION_OWNER="$owner" \
    timeout --kill-after=2s "${BULLET_CI_SOURCE_RESPONSE_SECONDS:?source monitor required}s" \
    node ops/ci/observation.mjs "$@"
}
lanes=(fast lint contract security docs)
log "required lane: ${lanes[*]} (standalone, sequential, exactly once)"
for lane in "${lanes[@]}"; do
  generation="$(observation_operation prepare "$lane")"
  if bash "ops/ci/${lane}.sh"; then
    observation_operation seal "$lane" "$generation" success 0
  else
    status=$?
    observation_operation seal "$lane" "$generation" failure "$status" || true
    exit "$status"
  fi
done
log "required lane execution completed; outer source custody acceptance pending"
