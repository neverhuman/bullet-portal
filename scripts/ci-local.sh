#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
lane="${1:-all}"
case "$lane" in
  required) bash ops/ci/required.sh ;;
  fast)     bash ops/ci/fast.sh ;;
  lint)     bash ops/ci/lint.sh ;;
  contract) bash ops/ci/contract.sh ;;
  security) bash ops/ci/security.sh ;;
  docs)     bash ops/ci/docs.sh ;;
  family)   bash ops/ci/family.sh ;;
  nightly)  bash ops/ci/nightly.sh ;;
  packaged-farmd) bash ops/ci/packaged-farmd.sh ;;
  coverage) bash ops/ci/coverage.sh ;;
  scheduled-hygiene) bash ops/ci/scheduled-hygiene.sh ;;
  portable) bash ops/ci/portable.sh ;;
  audit)    bash ops/ci/audit.sh ;;
  gates|all) bash ops/ci/required.sh ;;
  *) echo "usage: $0 {required|fast|lint|contract|security|docs|family|coverage|scheduled-hygiene|portable|audit|nightly|packaged-farmd|all}" >&2; exit 2 ;;
esac
