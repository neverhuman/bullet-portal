#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_node_floor
cd "$REPO_ROOT"

mode="${1:-forwarded}"
if (( $# > 1 )) || [[ "$mode" != forwarded && "$mode" != --packaged ]]; then
  echo '[ci] FARMD_PROOF_MODE_INVALID' >&2
  exit 1
fi
portal_origin="http://127.0.0.1:5173"
bind="127.0.0.1:0"
config="playwright.real.config.ts"
report="real-farmd"
expected_tests=3
features="bullet-verifier/fixture-executor"
if [[ "$mode" == --packaged ]]; then
  port="${BULLET_PACKAGED_PORT:-7421}"
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$port > 65535 )); then
    echo '[ci] FARMD_PROOF_PORT_INVALID' >&2
    exit 1
  fi
  portal_origin="http://127.0.0.1:$port"
  bind="127.0.0.1:$port"
  config="playwright.packaged.config.ts"
  report="packaged-farmd"
  expected_tests=7
  features+=",bullet-farmd/embedded-portal"
fi

family_root="$(cd "$REPO_ROOT/.." && pwd)"
kernel_root="$family_root/bullet-kernel"
if [[ ! -f "$kernel_root/Cargo.toml" ]]; then
  echo "[ci] sibling bullet-kernel checkout required at $kernel_root" >&2
  [[ "$mode" != --packaged ]] || exit 78
  exit 1
fi
proof_dir="$(mktemp -d)"
proof_dir="$(cd "$proof_dir" && pwd -P)"
farmd_pid=""
browser_pid=""
reports=""
public_reports=""
worker_token="wrk_2222222222222222222222222222222222222222222222222222222222222222"
worker_token_file="$proof_dir/worker.token"
bootstrap_token_file="$proof_dir/bootstrap.token"
umask 077
printf '%s\n' "$worker_token" >"$worker_token_file"

finish() {
  local proof_status=$?
  if [[ -n "$browser_pid" ]]; then
    kill -TERM -- "-$browser_pid" 2>/dev/null || true
    for _ in $(seq 1 240); do
      kill -0 -- "-$browser_pid" 2>/dev/null || break
      sleep 0.05
    done
    kill -KILL -- "-$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if [[ -n "$farmd_pid" ]]; then
    kill "$farmd_pid" 2>/dev/null || true
    wait "$farmd_pid" 2>/dev/null || true
  fi
  rm -f -- "$worker_token_file" "$bootstrap_token_file" "$proof_dir/custody/lease.key"
  if [[ -f "$proof_dir/farmd.log" ]]; then
    sed -i -E 's/boot_[0-9a-f]{64}/[REDACTED_BOOTSTRAP]/g' "$proof_dir/farmd.log"
  fi
  if [[ -f "$proof_dir/farmd.log" ]] || [[ -d "$proof_dir/worker" \
    && -n "$(find "$proof_dir/worker" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    # Keep the full receipt closure, exact binaries and ambiguous worker state.
    # This private fixture is never a release packet; do not export custody keys.
    printf '[ci] retained private component proof: %s\n' "$proof_dir" >&2
    if [[ -n "$public_reports" ]]; then
      jq -n --arg path "$proof_dir" --argjson status "$proof_status" \
        '{path:$path,exit_status:$status,evidence_class:"COMPONENT_PROOF",signing_trust:"UNSIGNED_FIXTURE",
          transaction_gate_eligible:false,independent_evidence_eligible:false,release_gate_eligible:false}' \
        >"$public_reports/$report-component-proof-location.json"
    fi
  else
    rm -rf "$proof_dir"
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "build production Portal bundle"
npm run build

bundle_root=""
if [[ "$mode" == --packaged ]]; then
  log "bind the exact clean-source Portal bundle"
  npm run bundle:generate
  npm run bundle:check
  bundle_root="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).root)' "$REPO_ROOT/dist/.bullet-portal-bundle-v1.json")"
  [[ "$bundle_root" =~ ^blake3:[0-9a-f]{64}$ ]] \
    || { echo '[ci] FARMD_BUNDLE_ROOT_INVALID' >&2; exit 1; }
fi

log "build local farmd and component command worker"
farmd_target="$proof_dir/cargo-target"
mkdir "$farmd_target"
(cd "$kernel_root"
  if [[ "$mode" == --packaged ]]; then
    export BULLET_PORTAL_DIST="$REPO_ROOT/dist"
  else
    unset BULLET_PORTAL_DIST
  fi
  CARGO_TARGET_DIR="$farmd_target" cargo build --locked \
  -p bullet-farmd -p bullet-runner -p bullet -p bullet-verifier \
  --features "$features" \
  --bin bullet-farmd --bin bullet-command-worker --bin transaction_offline \
  --bin bullet-runner --bin bullet-verifier-fixture)
farmd_bin="$farmd_target/debug/bullet-farmd"
declare -A binaries digests
for name in bullet-farmd bullet-command-worker transaction_offline bullet-runner bullet-verifier-fixture bullet-gitd; do
  binary="$farmd_target/debug/$name"
  [[ "$name" != bullet-gitd ]] || binary="${BULLET_GITD_BIN:-}"
  if [[ "$binary" != /* || ! -f "$binary" || ! -x "$binary" || -L "$binary" \
    || "$(realpath -e -- "$binary")" != "$binary" ]]; then
    echo "[ci] FARMD_BUILD_SUBJECT_INVALID: canonical executable required: $name" >&2
    exit 1
  fi
  permission="$(stat -Lc '%a' -- "$binary")"
  [[ "$(stat -Lc '%u' -- "$binary")" == "$(id -u)" && $((8#$permission & 8#22)) -eq 0 ]] \
    || { echo '[ci] FARMD_BUILD_SUBJECT_INVALID: unprotected executable' >&2; exit 1; }
  binaries[$name]="$binary"
  digests[$name]="$(sha256sum "$binary" | awk '{print $1}')"
done
[[ "${BULLET_GITD_SHA256:-}" =~ ^[0-9a-f]{64}$ \
  && "${digests[bullet-gitd]}" == "$BULLET_GITD_SHA256" ]] \
  || { echo '[ci] BULLET_GITD_DIGEST_MISMATCH' >&2; exit 1; }
# Hub's build directory expires after the family lane. Retain these exact bytes.
install -m 0700 -- "$BULLET_GITD_BIN" "$proof_dir/bullet-gitd"
[[ "$(sha256sum "$proof_dir/bullet-gitd" | awk '{print $1}')" == "$BULLET_GITD_SHA256" ]] \
  || { echo '[ci] BULLET_GITD_DIGEST_MISMATCH: retained copy' >&2; exit 1; }
binaries[bullet-gitd]="$proof_dir/bullet-gitd"

# Private fixture custody follows Kernel's public-command component proof.
# No operator key, provider enrollment, or release authority is used here.
mkdir -m 0700 "$proof_dir/custody" "$proof_dir/worker"
mkdir -m 0710 "$proof_dir/socket"
uid="$(id -u)"
gid="$(id -g)"
runner_id="run_1111111111111111111111111111111111111111111111111111111111111111"
registry="$proof_dir/custody/peers.json"
key="$proof_dir/custody/lease.key"
socket="$proof_dir/socket/lease.sock"
jq -cS -n --argjson uid "$uid" --argjson gid "$gid" --arg runner "$runner_id" \
  '{farmd_uid:$uid,socket_gid:$gid,runners:[{runner_id:$runner,runner_epoch:1,service_uid:$uid}]}' >"$registry"
"$farmd_bin" --provision-lease-transport-key "$key" >"$proof_dir/key.stdout" 2>"$proof_dir/key.stderr"
[[ "$(<"$proof_dir/key.stdout")" == "LEASE_TRANSPORT_KEY_PROVISIONED: $key" \
  && ! -s "$proof_dir/key.stderr" && ! -L "$key" \
  && "$(stat -Lc '%u:%a:%s:%F' -- "$key")" == "$uid:600:64:regular file" ]] \
  || { echo '[ci] FARMD_FIXTURE_KEY_INVALID' >&2; exit 1; }
manifest="$proof_dir/binaries.json"
jq -cS -j -n \
  --arg farmd "${binaries[bullet-farmd]}" --arg farmd_sha "${digests[bullet-farmd]}" \
  --arg transaction "${binaries[transaction_offline]}" --arg transaction_sha "${digests[transaction_offline]}" \
  --arg runner "${binaries[bullet-runner]}" --arg runner_sha "${digests[bullet-runner]}" \
  --arg verifier "${binaries[bullet-verifier-fixture]}" --arg verifier_sha "${digests[bullet-verifier-fixture]}" \
  --arg gitd "${binaries[bullet-gitd]}" --arg gitd_sha "${digests[bullet-gitd]}" \
  '{schema_version:"bullet.command-worker-binary-manifest.v1",
    farmd:{path:$farmd,sha256:$farmd_sha},transaction_offline:{path:$transaction,sha256:$transaction_sha},
    runner:{path:$runner,sha256:$runner_sha},verifier:{path:$verifier,sha256:$verifier_sha},
    gitd:{path:$gitd,sha256:$gitd_sha}}' >"$manifest"
"$farmd_bin" --provision-bootstrap-token "$bootstrap_token_file" >"$proof_dir/bootstrap.stdout" 2>"$proof_dir/bootstrap.stderr"
"$farmd_bin" --bootstrap-token-file "$bootstrap_token_file" --data-dir "$proof_dir/data" --bind "$bind" \
  --portal-origin "$portal_origin" \
  --worker-token-file "$worker_token_file" \
  --lease-transport-socket "$socket" --lease-peer-registry "$registry" \
  --lease-transport-key "$key" \
  >"$proof_dir/farmd.log" 2>&1 &
farmd_pid="$!"

farmd_origin=""
for _ in $(seq 1 100); do
  farmd_origin="$(sed -n 's/.*bullet-farmd listening on \(127\.0\.0\.1:[0-9][0-9]*\)$/http:\/\/\1/p' "$proof_dir/farmd.log" | tail -n 1)"
  if [[ "$farmd_origin" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] && \
    curl --fail --silent "$farmd_origin/health" >/dev/null; then
    break
  fi
  if ! kill -0 "$farmd_pid" 2>/dev/null; then
    sed -n '1,160p' "$proof_dir/farmd.log" >&2
    exit 1
  fi
  sleep 0.1
done
farmd_port="${farmd_origin##*:}"
if [[ ! "$farmd_origin" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || \
  (( farmd_port < 1 || farmd_port > 65535 )) || \
  ! curl --fail --silent "$farmd_origin/health" >/dev/null; then
  sed -n '1,160p' "$proof_dir/farmd.log" >&2
  exit 1
fi

if [[ "$mode" == --packaged ]]; then
  [[ "$farmd_origin" == "$portal_origin" ]] \
    || { echo '[ci] FARMD_PACKAGED_ORIGIN_MISMATCH' >&2; exit 1; }
  curl --fail --silent "$farmd_origin/health" | jq -e --arg root "$bundle_root" '.portal == $root' >/dev/null \
    || { echo '[ci] FARMD_PACKAGED_BUNDLE_MISMATCH' >&2; exit 1; }
  index="$(curl --fail --silent "$farmd_origin/")"
  [[ "$index" == *'<div id="root">'* ]] \
    || { echo '[ci] FARMD_PACKAGED_ENTRYPOINT_MISSING' >&2; exit 1; }
  log "packaged farmd serves exact bundle $bundle_root at $farmd_origin"
fi

bootstrap_token="$(<"$bootstrap_token_file")"
if [[ ! "$bootstrap_token" =~ ^boot_[0-9a-f]{64}$ ]]; then
  echo "[ci] private bootstrap file does not contain one valid token" >&2
  exit 1
fi

cd "$REPO_ROOT"
public_reports="$(artifact_dir reports)"
# Raw failures can contain credential-bearing subprocess or browser diagnostics.
# Keep them with the private fixture, never in an uploadable repository report.
reports="$proof_dir/reports"
mkdir -m 0700 "$reports"
setsid env BULLET_FARMD_TEST_PROXY="$farmd_origin" \
BULLET_FARMD_URL="$farmd_origin" \
  BULLET_PACKAGED_URL="$portal_origin" \
  BULLET_COMPONENT_WORKER_BIN="${binaries[bullet-command-worker]}" \
  BULLET_COMPONENT_PROOF_DIR="$proof_dir" \
  BULLET_COMPONENT_REPORT_DIR="$reports" \
  BULLET_COMPONENT_SUPERVISOR="$REPO_ROOT/tests/component-process.py" \
  BULLET_BOOTSTRAP_TOKEN="$bootstrap_token" \
  BULLET_WORKER_TOKEN="$worker_token" \
  PLAYWRIGHT_JUNIT_OUTPUT_NAME="$reports/$report.xml" \
  PLAYWRIGHT_JUNIT_STRIP_ANSI=1 \
  ./node_modules/.bin/playwright test --config "$config" --output "$proof_dir/browser-results" --reporter=line,junit &
browser_pid=$!
wait "$browser_pid"
node ops/ci/assert-report.mjs junit "$reports/$report.xml" "$expected_tests"
for name in "${!binaries[@]}"; do
  [[ "$(sha256sum "${binaries[$name]}" | awk '{print $1}')" == "${digests[$name]}" ]] \
    || { echo "[ci] FARMD_BUILD_SUBJECT_CHANGED: $name" >&2; exit 1; }
done
[[ "$(sha256sum "$BULLET_GITD_BIN" | awk '{print $1}')" == "$BULLET_GITD_SHA256" ]] \
  || { echo '[ci] BULLET_GITD_DIGEST_MISMATCH: original changed' >&2; exit 1; }
