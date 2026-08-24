default:
    @just --list

setup:
    npm ci --no-fund --no-audit
    ./node_modules/.bin/playwright install chromium

fast:
    bash scripts/ci-local.sh fast

check:
    bash scripts/ci-local.sh required

contract:
    bash scripts/ci-local.sh contract

security:
    bash scripts/ci-local.sh security

audit:
    bash scripts/ci-local.sh audit

nightly:
    bash scripts/ci-local.sh nightly
