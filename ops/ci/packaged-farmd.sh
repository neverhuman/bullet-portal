#!/usr/bin/env bash
# The shared component proof provisions the same worker, peer registry and
# receipt custody in both modes. Packaged mode verifies a clean-source bundle
# and embeds it in farmd, then runs all seven browser cases at that exact origin.
# It never starts Vite. Absent sibling Kernel exits 78, which is not success.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/real-farmd.sh" --packaged "$@"
