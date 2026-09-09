#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
lanes=(fast lint contract security docs)
log "required lane: ${lanes[*]} (standalone, sequential, exactly once)"
for lane in "${lanes[@]}"; do
  if bash "ops/ci/${lane}.sh"; then
    bash scripts/ci-observation.sh "$lane" success 0
  else
    status=$?
    bash scripts/ci-observation.sh "$lane" failure "$status" || true
    exit "$status"
  fi
done
log "required lane passed"
