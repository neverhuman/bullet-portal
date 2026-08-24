#!/usr/bin/env bash
# Unit lane plus the production bundle proof. Required adds mocked and real-process Playwright.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "fast lane: tsc + vitest + vite build"
./node_modules/.bin/tsc --noEmit
npm test
npm run build
log "fast lane passed"
