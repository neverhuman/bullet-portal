#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor

reports="$(artifact_dir reports)"
coverage="$(artifact_dir coverage)"
log "coverage lane: all unit/component tests with ratcheted summary"
./node_modules/.bin/vitest run --reporter=json \
  --outputFile="$reports/coverage-tests.json" \
  --coverage --coverage.reporter=text --coverage.reporter=json-summary \
  --coverage.reportsDirectory="$coverage" \
  '--coverage.include=src/**/*.{ts,tsx}' \
  '--coverage.exclude=src/**/*.test.{ts,tsx}' \
  --coverage.exclude=src/test-setup.ts \
  --coverage.exclude=src/env.d.ts \
  '--coverage.exclude=src/generated/**'
node ops/ci/assert-report.mjs vitest "$reports/coverage-tests.json" 184 \
  50c1aa4faa0197191fa5625495cc2b612173d4277ff4106c79cadbe32179a6f1
node ops/ci/assert-coverage.mjs "$coverage/coverage-summary.json"
log "coverage lane passed"
