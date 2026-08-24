#!/usr/bin/env bash
# Unit lane plus the production bundle proof. Playwright is contract/e2e, never required.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
log "fast lane: tsc + vitest + vite build"
npx tsc --noEmit
npm test
npm run build
log "fast lane passed"
