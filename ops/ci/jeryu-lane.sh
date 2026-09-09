#!/usr/bin/env bash
# Prepared Jeryu adapter: preserve the local lane command and emit only an
# unsigned diagnostic observation. ci.toml's activation gate always runs first.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

lane="${1:-}"
case "$lane" in
  fast|lint|contract|security|docs) ;;
  *)
    echo "usage: $0 {fast|lint|contract|security|docs}" >&2
    exit 2
    ;;
esac

set +e
bash scripts/ci-local.sh "$lane"
status=$?
set -e
outcome=failure
[[ "$status" -eq 0 ]] && outcome=success
bash scripts/ci-observation.sh \
  "$lane" "$outcome" "$status" "bash scripts/ci-local.sh $lane"
node ops/ci/sanitize-artifacts.mjs "$lane"
exit "$status"
