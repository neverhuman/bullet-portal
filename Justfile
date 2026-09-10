default:
    @just --list

setup:
    node ops/ci/preinstall-scan.mjs
    bash -c 'source ops/ci/lib.sh; require_node_floor'
    npm ci --ignore-scripts --no-fund --no-audit

setup-rendered: setup
    node --input-type=module -e 'import { requireRenderedHost } from "./ops/proof/rendered-host.ts"; requireRenderedHost();'
    ./node_modules/.bin/playwright install chromium

fast:
    bash scripts/ci-local.sh fast

check:
    bash scripts/ci-local.sh required

contract:
    bash scripts/ci-local.sh contract

rendered:
    bash scripts/ci-local.sh rendered

lint:
    bash scripts/ci-local.sh lint

docs:
    bash scripts/ci-local.sh docs

security:
    bash scripts/ci-local.sh security

audit:
    bash scripts/ci-local.sh audit

nightly:
    bash scripts/ci-local.sh nightly

# Real sibling-farmd proof. Never part of standalone required.
family:
    bash scripts/ci-local.sh family

# Browser proof against a packaged farmd that serves this Portal itself.
# Neutral 78 without the sibling bullet-kernel checkout.
packaged-farmd:
    bash scripts/ci-local.sh packaged-farmd

score:
    mkdir -p .jankurai
    rm -f .jankurai/repo-score.json .jankurai/repo-score.md .jankurai/repair-queue.jsonl
    jankurai audit . --full --no-score-history --json .jankurai/repo-score.json --md .jankurai/repo-score.md

vitest-fast:
    ./node_modules/.bin/vitest run

check-types:
    ./node_modules/.bin/tsc -p tsconfig.json --noEmit

playwright-contract:
    bash scripts/ci-local.sh rendered
