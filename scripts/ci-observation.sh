#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

lane="${1:?lane is required}"
outcome="${2:?outcome is required}"
exit_code="${3:?exit code is required}"
shift 3
node ops/ci/observation.mjs "$lane" "$outcome" "$exit_code" "$@"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'present=true\n' >>"$GITHUB_OUTPUT"
fi
