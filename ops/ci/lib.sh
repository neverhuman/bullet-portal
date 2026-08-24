#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT
log() { printf '[ci] %s\n' "$*"; }

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[ci] missing required tool: %s\n' "$1" >&2
    return 1
  fi
}
