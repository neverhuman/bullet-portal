#!/usr/bin/env bash
# All mocked browser scenarios run locally on xbabe2, outside CI.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
node --input-type=module -e 'import { requireRenderedHost } from "./ops/proof/rendered-host.ts"; requireRenderedHost();'
require_node_floor
reports="$(artifact_dir reports)"
playwright_output="$(artifact_dir playwright)"
log "rendered lane: xbabe2-local mocked Playwright"
PLAYWRIGHT_JUNIT_OUTPUT_NAME="$reports/playwright.xml" \
PLAYWRIGHT_JUNIT_STRIP_ANSI=1 \
  ./node_modules/.bin/playwright test --reporter=line,junit \
    --output "$playwright_output" --trace retain-on-failure
node ops/ci/assert-report.mjs junit "$reports/playwright.xml" 24 \
  bdc2efe35deb43edba551683069ba0901fd8eb5ec882aadf50d46c7e6498cd3c
log "rendered lane passed"
