#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT
log() { printf '[ci] %s\n' "$*"; }

artifact_dir() {
  local path="$REPO_ROOT/.ci-artifacts/$1"
  mkdir -p "$path"
  printf '%s\n' "$path"
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[ci] missing required tool: %s\n' "$1" >&2
    return 1
  fi
}

# The historical function name is retained for callers, but the hosted/local
# contract is an exact toolchain identity rather than a major-version floor.
require_node_floor() {
  require_tool node || return 1
  require_tool npm || return 1
  local node_version npm_version
  node_version="$(node --version)"
  npm_version="$(npm --version)"
  if [[ "$node_version" != "v22.23.2" || "$npm_version" != "10.9.8" ]]; then
    printf '[ci] PORTAL_TOOLCHAIN_VERSION_MISMATCH: expected Node v22.23.2 and npm 10.9.8; found %s / %s\n' \
      "$node_version" "$npm_version" >&2
    return 1
  fi
}
