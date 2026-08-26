#!/usr/bin/env bash
# Local environment check: does this machine have what the ops/ci lanes need?
#
# It answers one question per lane -- "would this lane fail for an environment
# reason rather than a code reason?" -- before you spend a build. It runs
# nothing from the lanes themselves and mutates nothing.
#
# Lanes mirror `scripts/ci-local.sh` and `agent/proof-lanes.toml`. When a lane
# is added there, add its tool row here in the same change; a lane with no row
# is a usage error, never a silent pass.
set -euo pipefail
# shellcheck source=ops/ci/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../ops/ci/lib.sh"

lane="${1:-all}"
case "$lane" in
  fast)     tools=(bash dirname git node npm) ;;
  lint)     tools=(actionlint bash dirname find git shellcheck sort) ;;
  contract) tools=(bash dirname git node npm) ;;
  security) tools=(bash dirname git gitleaks grep mktemp node npm zizmor) ;;
  docs)     tools=(bash chmod cp dirname git grep mkdir mktemp node npm rm) ;;
  required) tools=(actionlint bash chmod cp dirname find git gitleaks grep mkdir mktemp node npm rm shellcheck sort zizmor) ;;
  coverage) tools=(bash dirname git node npm) ;;
  portable) tools=(bash dirname git node npm) ;;
  scheduled-hygiene) tools=(bash dirname git gitleaks node npm) ;;
  family|packaged-farmd) tools=(bash cargo dirname git node npm rustc uname) ;;
  audit)    tools=(bash dirname git jankurai mkdir) ;;
  nightly)  tools=(bash dirname git node npm) ;;
  all)      tools=(actionlint bash cargo chmod cp dirname find git gitleaks grep jankurai mkdir mktemp node npm rm rustc shellcheck sort uname zizmor) ;;
  *)
    echo "ci-doctor: expected fast|lint|contract|security|docs|required|coverage|portable|scheduled-hygiene|family|packaged-farmd|audit|nightly|all" >&2
    exit 2
    ;;
esac
tools+=(stat wc)

missing=0
for tool in "${tools[@]}"; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'ci-doctor: missing %s for %s\n' "$tool" "$lane" >&2
    missing=1
  fi
done
[[ "$missing" -eq 0 ]] || exit 1

# `require_node_floor` retains its historical name but enforces the exact local
# and hosted Node/npm identities. Refuse drift before starting a lane.
if [[ "$lane" =~ ^(fast|lint|contract|security|docs|required|coverage|portable|scheduled-hygiene|family|packaged-farmd|nightly|all)$ ]]; then
  require_node_floor
fi
if [[ "$lane" =~ ^(security|required|scheduled-hygiene|all)$ ]]; then
  [[ "$(gitleaks version)" == "8.21.2" ]] || {
    printf 'ci-doctor: expected gitleaks 8.21.2, found %s\n' "$(gitleaks version)" >&2
    exit 1
  }
fi
if [[ "$lane" =~ ^(security|required|all)$ ]]; then
  [[ "$(zizmor --version)" == "zizmor 1.25.2" ]] || {
    printf 'ci-doctor: expected zizmor 1.25.2, found %s\n' "$(zizmor --version)" >&2
    exit 1
  }
fi
if [[ "$lane" =~ ^(lint|required|all)$ ]]; then
  [[ "$(actionlint -version | head -n 1)" == "1.7.8" ]] || {
    echo "ci-doctor: expected actionlint 1.7.8" >&2
    exit 1
  }
  [[ "$(shellcheck --version | sed -n 's/^version: //p')" == "0.10.0" ]] || {
    echo "ci-doctor: expected ShellCheck 0.10.0" >&2
    exit 1
  }
fi
if [[ "$lane" == audit || "$lane" == all ]]; then
  [[ "$(jankurai --version)" == "jankurai 1.6.11" ]] || {
    printf 'ci-doctor: expected jankurai 1.6.11, found %s\n' "$(jankurai --version)" >&2
    exit 1
  }
fi
# node_modules is not a tool, but every lane except `audit` needs it and a
# missing install is the most common cause of a confusing local red.
if [[ "$lane" != "audit" && ! -d node_modules ]]; then
  echo "ci-doctor: node_modules is missing; run: npm ci --ignore-scripts --no-fund --no-audit" >&2
  exit 1
fi
printf 'ci-doctor: %s lane tools present\n' "$lane"
