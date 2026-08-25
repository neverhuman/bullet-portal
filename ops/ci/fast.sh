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
npm run build
log "fast lane passed"
