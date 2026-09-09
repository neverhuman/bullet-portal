#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

bash ops/ci/fast.sh
platform_dir="$(artifact_dir platform)"
node ops/ci/platform-refusal.mjs >"$platform_dir/refusal.json"
node ops/ci/platform-refusal.mjs --check "$platform_dir/refusal.json"
log "portable compile and typed refusal passed"
