#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

lane="${1:?lane is required}"
outcome="${2:?outcome is required}"
exit_code="${3:?exit code is required}"
shift 3
if node ops/ci/observation.mjs "$lane" "$outcome" "$exit_code" "$@"; then
  :
else
  observation_status=$?
  # A failed publisher cannot create a valid source proof. Retain only a typed
  # diagnostic and preserve its original failure, even if diagnostic staging fails.
  node ops/ci/refusal-diagnostic.mjs "$lane" "$outcome" "$exit_code" "$observation_status" || true
  exit "$observation_status"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'present=true\n' >>"$GITHUB_OUTPUT"
fi
