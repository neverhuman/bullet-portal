#!/usr/bin/env bash
# Standalone unit/type/build lane. It never resolves a sibling repository.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor
reports="$(artifact_dir reports)"
log "fast lane: vitest + typed production build"
./node_modules/.bin/vitest run --reporter=json \
  --outputFile="$reports/vitest.json"
node ops/ci/assert-report.mjs vitest "$reports/vitest.json" 106
if VITE_BULLET_API="https://hostile.invalid" npm run build \
  >"$reports/vite-api-override.log" 2>&1; then
  printf '[ci] VITE_BULLET_API_UNSUPPORTED: configured API override was accepted\n' >&2
  exit 1
fi
if ! grep -Fq 'VITE_BULLET_API_UNSUPPORTED' "$reports/vite-api-override.log"; then
  printf '[ci] VITE_BULLET_API_UNSUPPORTED: typed refusal was not observed\n' >&2
  exit 1
fi
npm run build
log "fast lane passed"
