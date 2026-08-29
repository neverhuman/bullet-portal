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
  8a95898f88efe2d2f8c7a2f2883868041ec96cb60a20d31af6761300a94983ad
log "contract lane passed"
