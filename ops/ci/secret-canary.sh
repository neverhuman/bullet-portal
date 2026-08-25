#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool gitleaks || exit 1

canary_dir="$(mktemp -d)"
finish() {
  rm -rf -- "$canary_dir"
}
trap finish EXIT

# Split the fake value in committed source so the repository scan remains clean;
# only the disposable canary file contains the detector-shaped string.
printf '%s%s\n' \
  'const deploymentCredential = "ghp_' \
  '1234567890abcdefghijklmnopqrstuvwxyz";' >"$canary_dir/canary.ts"

if gitleaks detect --source "$canary_dir" --no-git --redact --no-banner \
  >"$canary_dir/result.log" 2>&1; then
  echo "[ci] SECRET_CANARY_MISSED: gitleaks accepted a detector-shaped credential" >&2
  exit 1
fi
log "secret canary refused as expected"
