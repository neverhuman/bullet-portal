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

require_node_floor() {
  require_tool node || return 1
  require_tool npm || return 1
  local node_major npm_major
  node_major="$(node --version)"
  node_major="${node_major#v}"
  node_major="${node_major%%.*}"
  npm_major="$(npm --version)"
  npm_major="${npm_major%%.*}"
  if (( node_major < 22 || npm_major < 10 )); then
    printf '[ci] Node >=22 and npm >=10 required (found %s / %s)\n' \
      "$(node --version)" "$(npm --version)" >&2
    return 1
  fi
}
