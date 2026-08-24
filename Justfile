default:
    @just --list

setup:
    npm install --no-fund --no-audit
    npx playwright install chromium

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
