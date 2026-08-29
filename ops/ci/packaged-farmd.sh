#!/usr/bin/env bash
# Packaged-farmd browser lane: the real-process Playwright spec from
# ops/ci/real-farmd.sh plus the mocked Shift Brief routing spec, against a farmd
# binary that serves this Portal's built bytes itself. There is no Vite dev or
# preview server here — the browser origin IS the daemon origin, which is what
# a packaged Linux distribution ships. The daemon embeds dist/ only after its
# build script re-verifies every byte against .bullet-portal-bundle-v1.json, so
# this lane also proves the packaged bundle subject end to end.
#
# Fails closed on every real failure. The one neutral outcome (78) is an absent
# sibling Kernel checkout: this lane is additive to required, which still
# fails closed through ops/ci/real-farmd.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"
require_node_floor

family_root="$(cd "$REPO_ROOT/.." && pwd)"
kernel_root="$family_root/bullet-kernel"
if [[ ! -f "$kernel_root/Cargo.toml" ]]; then
  log "neutral (78): sibling bullet-kernel checkout absent at $kernel_root"
  exit 78
fi

port="${BULLET_PACKAGED_PORT:-7421}"
origin="http://127.0.0.1:${port}"
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

log "bind the exact bundle subject (refuses on a dirty source tree)"
npm run bundle:generate
npm run bundle:check
bundle_root="$(node -e 'const m=require("node:fs").readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.parse(m).root)' "$REPO_ROOT/dist/.bullet-portal-bundle-v1.json")"
if [[ ! "$bundle_root" =~ ^blake3:[0-9a-f]{64}$ ]]; then
  echo "[ci] the bundle manifest has no framed BLAKE3 root" >&2
  exit 1
fi
log "bundle root ${bundle_root}"

log "build packaged farmd with the embedded Portal"
(cd "$kernel_root" && BULLET_PORTAL_DIST="$REPO_ROOT/dist" \
  cargo build --locked -p bullet-farmd --features embedded-portal)
farmd_bin="$kernel_root/target/debug/bullet-farmd"

"$farmd_bin" --data-dir "$proof_dir/data" --bind "127.0.0.1:${port}" \
  --portal-origin "$origin" \
  --worker-token-file "$worker_token_file" \
  >"$proof_dir/farmd.log" 2>&1 &
farmd_pid="$!"

ready=0
for _ in $(seq 1 100); do
  if curl --fail --silent "${origin}/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then
  sed -n '1,160p' "$proof_dir/farmd.log" >&2
  exit 1
fi

health="$(curl --fail --silent "${origin}/health")"
if [[ "$health" != *"\"portal\":\"${bundle_root}\""* ]]; then
  echo "[ci] packaged farmd does not serve this exact bundle subject: $health" >&2
  exit 1
fi
log "packaged farmd serves the Portal at its own origin ${origin}"

index="$(curl --fail --silent "${origin}/")"
if [[ "$index" != *"<div id=\"root\">"* ]]; then
  echo "[ci] the packaged origin does not serve the Portal entry point" >&2
  exit 1
fi

bootstrap_token="$(sed -n 's/^Bullet Farm one-time bootstrap: //p' "$proof_dir/farmd.log" | head -n 1)"
if [[ ! "$bootstrap_token" =~ ^boot_[0-9a-f]{64}$ ]]; then
  echo "[ci] farmd did not emit one valid bootstrap token" >&2
  exit 1
fi

BULLET_FARMD_URL="$origin" \
  BULLET_PACKAGED_URL="$origin" \
  BULLET_BOOTSTRAP_TOKEN="$bootstrap_token" \
  BULLET_WORKER_TOKEN="$worker_token" \
  PLAYWRIGHT_JUNIT_OUTPUT_NAME="$(artifact_dir reports)/packaged-farmd.xml" \
  PLAYWRIGHT_JUNIT_STRIP_ANSI=1 \
  ./node_modules/.bin/playwright test --config playwright.packaged.config.ts --reporter=line,junit
node ops/ci/assert-report.mjs junit "$(artifact_dir reports)/packaged-farmd.xml" 7
log "packaged-farmd lane passed"
