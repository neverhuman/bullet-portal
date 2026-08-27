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
node ops/ci/assert-report.mjs junit "$reports/playwright.xml" 13 \
  740ea52193f3c5e41bc4e0347142f3a5ff0b8840d4d55feb5279892bb1efc993
log "contract lane passed"
