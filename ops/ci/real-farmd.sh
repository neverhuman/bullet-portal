#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

family_root="$(cd "$REPO_ROOT/.." && pwd)"
kernel_root="$family_root/bullet-kernel"
if [[ ! -f "$kernel_root/Cargo.toml" ]]; then
  echo "[ci] sibling bullet-kernel checkout required at $kernel_root" >&2
  exit 1
fi
proof_dir="$(mktemp -d)"
farmd_pid=""

finish() {
  if [[ -n "$farmd_pid" ]]; then
    kill "$farmd_pid" 2>/dev/null || true
    wait "$farmd_pid" 2>/dev/null || true
  fi
  rm -rf "$proof_dir"
}
trap finish EXIT

log "build local farmd"
(cd "$kernel_root" && cargo build --locked -p bullet-farmd)
farmd_bin="$kernel_root/target/debug/bullet-farmd"
"$farmd_bin" --data-dir "$proof_dir/data" --bind 127.0.0.1:7420 \
  >"$proof_dir/farmd.log" 2>&1 &
farmd_pid="$!"

ready=0
for _ in $(seq 1 100); do
  if curl --fail --silent http://127.0.0.1:7420/health >/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then
  sed -n '1,160p' "$proof_dir/farmd.log" >&2
  exit 1
fi

cd "$REPO_ROOT"
BULLET_FARMD_URL=http://127.0.0.1:7420 \
  ./node_modules/.bin/playwright test --config playwright.real.config.ts
