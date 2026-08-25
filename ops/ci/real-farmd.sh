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
worker_token="wrk_2222222222222222222222222222222222222222222222222222222222222222"
worker_token_file="$proof_dir/worker.token"
umask 077
printf '%s\n' "$worker_token" >"$worker_token_file"

finish() {
  if [[ -n "$farmd_pid" ]]; then
    kill "$farmd_pid" 2>/dev/null || true
    wait "$farmd_pid" 2>/dev/null || true
  fi
  rm -rf "$proof_dir"
}
trap finish EXIT

log "build production Portal bundle"
npm run build

log "build local farmd"
(cd "$kernel_root" && cargo build --locked -p bullet-farmd)
farmd_bin="$kernel_root/target/debug/bullet-farmd"
"$farmd_bin" --data-dir "$proof_dir/data" --bind 127.0.0.1:7420 \
  --portal-origin http://127.0.0.1:5173 \
  --worker-token-file "$worker_token_file" \
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

bootstrap_token="$(sed -n 's/^Bullet Farm one-time bootstrap: //p' "$proof_dir/farmd.log" | head -n 1)"
if [[ ! "$bootstrap_token" =~ ^boot_[0-9a-f]{64}$ ]]; then
  echo "[ci] farmd did not emit one valid bootstrap token" >&2
  exit 1
fi

cd "$REPO_ROOT"
BULLET_FARMD_URL=http://127.0.0.1:7420 \
  BULLET_BOOTSTRAP_TOKEN="$bootstrap_token" \
  BULLET_WORKER_TOKEN="$worker_token" \
  ./node_modules/.bin/playwright test --config playwright.real.config.ts
