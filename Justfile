default:
    @just --list

setup:
    npm install --no-fund --no-audit
    npx playwright install chromium

fast:
    bash scripts/ci-local.sh fast

check:
    bash scripts/ci-local.sh required
