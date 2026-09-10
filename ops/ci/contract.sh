#!/usr/bin/env bash
# Mocked e2e. No live farmd and no live models.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor
reports="$(artifact_dir reports)"
playwright_output="$(artifact_dir playwright)"
log "contract lane: bundle contracts + mocked Playwright"
npm run bundle:typecheck
npm run bundle:test
PLAYWRIGHT_JUNIT_OUTPUT_NAME="$reports/playwright.xml" \
PLAYWRIGHT_JUNIT_STRIP_ANSI=1 \
  ./node_modules/.bin/playwright test --reporter=line,junit \
    --output "$playwright_output" --trace retain-on-failure
node ops/ci/assert-report.mjs junit "$reports/playwright.xml" 14 \
  ab971010688d4c8a422a452eea2278845d17ae4b6914bd0bba5f136b3e3fe899
log "contract lane passed"
