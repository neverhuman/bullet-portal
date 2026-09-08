#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

require_tool actionlint || exit 1
require_tool shellcheck || exit 1
require_tool python3 || exit 1
[[ "$(uname -s)" == Linux ]] || { echo '[ci] COMPONENT_PROCESS_TEST_LINUX_REQUIRED' >&2; exit 1; }
[[ "$(actionlint -version | head -n 1)" == "1.7.8" ]] || {
  echo "[ci] actionlint 1.7.8 required" >&2
  exit 1
}
shellcheck_version="$(shellcheck --version | sed -n 's/^version: //p')"
[[ "$shellcheck_version" == "0.10.0" ]] || {
  echo "[ci] ShellCheck 0.10.0 required" >&2
  exit 1
}

log "lint lane: actionlint + ShellCheck + whitespace"
actionlint
mapfile -t shell_files < <(find ops/ci scripts -type f -name '*.sh' -print | sort)
(( ${#shell_files[@]} > 0 )) || { echo "[ci] zero shell files discovered" >&2; exit 1; }
shellcheck -x -P ops/ci "${shell_files[@]}"
bash ops/ci/proof-custody-test.sh
bash ops/ci/farmd-build-test.sh
python3 -I -B tests/component-process-test.py
git diff --check
log "lint lane passed (${#shell_files[@]} shell files)"
