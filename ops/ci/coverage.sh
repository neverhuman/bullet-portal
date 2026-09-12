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
node ops/ci/assert-report.mjs vitest "$reports/coverage-tests.json" 372 \
  7d47523612afcd80b234c6cb71f44afbc23569134f0e4c3cb7451f37f2b427d9
node ops/ci/assert-coverage.mjs "$coverage/coverage-summary.json"
log "coverage lane passed"
