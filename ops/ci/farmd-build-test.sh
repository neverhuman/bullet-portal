#!/usr/bin/env bash
# Copied family script with fake Cargo; never builds or resolves canonical Kernel.
set -euo pipefail
umask 077
portal="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
scratch="$(cd "$scratch" && pwd -P)"
fixture="$scratch/family"
mkdir -p "$fixture/bullet-portal/ops/ci" "$fixture/bullet-kernel/target/debug" \
  "$scratch/caller/debug" "$scratch/bin" "$scratch/tmp"
cp "$portal/ops/ci/real-farmd.sh" "$fixture/bullet-portal/ops/ci/real-farmd.sh"
: >"$fixture/bullet-kernel/Cargo.toml"
cat >"$fixture/bullet-portal/ops/ci/lib.sh" <<'FIXTURE'
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
require_node_floor() { :; }
log() { :; }
FIXTURE
cat >"$scratch/poison" <<'FIXTURE'
#!/usr/bin/env bash
printf 'stale\n' >"$FIXTURE_ROOT/poison-launched"
exit 45
FIXTURE
chmod +x "$scratch/poison"
cp "$scratch/poison" "$scratch/gitd"
gitd_sha="$(sha256sum "$scratch/gitd" | awk '{print $1}')"
cp "$scratch/poison" "$fixture/bullet-kernel/target/debug/bullet-farmd"
cp "$scratch/poison" "$scratch/caller/debug/bullet-farmd"
cat >"$scratch/bin/npm" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'run bundle:generate' ]]; then
  mkdir -p dist
  printf '{"root":"blake3:%064d"}\n' 0 >dist/.bullet-portal-bundle-v1.json
fi
if [[ "$*" == 'run bundle:check' ]]; then
  [[ -f dist/.bullet-portal-bundle-v1.json ]]
  : >"$FIXTURE_ROOT/bundle-checked"
fi
FIXTURE
cat >"$scratch/bin/cargo" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$PWD" == "$FIXTURE_ROOT/family/bullet-kernel" ]]
features="bullet-verifier/fixture-executor"
if [[ "$FIXTURE_PACKAGED" == 1 ]]; then
  features+=",bullet-farmd/embedded-portal"
  [[ "$BULLET_PORTAL_DIST" == "$FIXTURE_ROOT/family/bullet-portal/dist" ]]
  [[ -f "$FIXTURE_ROOT/bundle-checked" ]]
else
  [[ -z "${BULLET_PORTAL_DIST+x}" ]]
fi
[[ "$*" == "build --locked -p bullet-farmd -p bullet-runner -p bullet -p bullet-verifier --features $features --bin bullet-farmd --bin bullet-command-worker --bin transaction_offline --bin bullet-runner --bin bullet-verifier-fixture" ]]
[[ "$CARGO_TARGET_DIR" == "$FIXTURE_ROOT"/tmp/*/cargo-target ]]
[[ "$(realpath -e "$CARGO_TARGET_DIR")" == "$CARGO_TARGET_DIR" ]]
printf '%s\n' "$CARGO_TARGET_DIR" >"$FIXTURE_ROOT/selected-target"
[[ "$FIXTURE_MODE" != fail ]] || exit 23
[[ "$FIXTURE_MODE" != missing ]] || exit 0
if [[ "$FIXTURE_MODE" == parent-link ]]; then
  mkdir "$CARGO_TARGET_DIR/actual"
  ln -s actual "$CARGO_TARGET_DIR/debug"
else
  mkdir "$CARGO_TARGET_DIR/debug"
fi
binary="$CARGO_TARGET_DIR/debug/bullet-farmd"
if [[ "$FIXTURE_MODE" == link ]]; then
  ln -s "$FIXTURE_ROOT/poison" "$binary"
elif [[ "$FIXTURE_MODE" == directory ]]; then
  mkdir "$binary"
else
  printf '#!/usr/bin/env bash\nprintf "fresh\\n" >"$FIXTURE_ROOT/fresh-launched"\nexit 43\n' >"$binary"
  [[ "$FIXTURE_MODE" == nonexecutable ]] || chmod +x "$binary"
  [[ "$FIXTURE_MODE" != writable ]] || chmod g+w "$binary"
fi
for name in bullet-command-worker transaction_offline bullet-runner bullet-verifier-fixture; do
  [[ "$FIXTURE_MODE" != "missing-$name" ]] || continue
  cp "$FIXTURE_ROOT/poison" "$CARGO_TARGET_DIR/debug/$name"
done
FIXTURE
chmod +x "$scratch/bin/npm" "$scratch/bin/cargo"
ln -s "$scratch/tmp" "$scratch/tmp-link"
passed=0
for packaged in 0 1; do
proof_args=()
[[ "$packaged" != 1 ]] || proof_args+=(--packaged)
for mode in valid relative-caller temporary-link fail missing link parent-link nonexecutable directory writable \
  missing-bullet-command-worker missing-transaction_offline missing-bullet-runner \
  missing-bullet-verifier-fixture gitd-drift; do
  rm -f "$scratch/selected-target" "$scratch/fresh-launched" "$scratch/poison-launched" "$scratch/bundle-checked"
  caller="$scratch/caller"
  temporary="$scratch/tmp"
  [[ "$mode" != relative-caller ]] || caller=relative-caller
  [[ "$mode" != temporary-link ]] || temporary="$scratch/tmp-link"
  expected_gitd="$gitd_sha"
  [[ "$mode" != gitd-drift ]] || expected_gitd="$(printf '%064d' 0)"
  status=0
  env PATH="$scratch/bin:$PATH" TMPDIR="$temporary" CARGO_TARGET_DIR="$caller" \
    BULLET_GITD_BIN="$scratch/gitd" BULLET_GITD_SHA256="$expected_gitd" \
    FIXTURE_ROOT="$scratch" FIXTURE_MODE="$mode" FIXTURE_PACKAGED="$packaged" \
    BULLET_PORTAL_DIST="/must-not-inherit-from-caller" \
    bash "$fixture/bullet-portal/ops/ci/real-farmd.sh" "${proof_args[@]}" >"$scratch/output" 2>&1 || status=$?
  [[ "$status" -ne 0 && -f "$scratch/selected-target" && ! -e "$scratch/poison-launched" ]] \
    || { printf '[ci] farmd target fixture failed: %s\n' "$mode" >&2; exit 1; }
  selected="$(<"$scratch/selected-target")"
  [[ ! -e "${selected%/cargo-target}" ]] || { echo '[ci] farmd proof directory leaked' >&2; exit 1; }
  case "$mode" in
    valid|relative-caller|temporary-link)
      [[ -f "$scratch/fresh-launched" && "$(<"$scratch/fresh-launched")" == fresh ]] \
        || { cat "$scratch/output" >&2; exit 1; } ;;
    fail)
      [[ "$status" -eq 23 && ! -e "$scratch/fresh-launched" ]] ;;
    gitd-drift)
      [[ ! -e "$scratch/fresh-launched" ]]
      grep -Fq BULLET_GITD_DIGEST_MISMATCH "$scratch/output" ;;
    *)
      [[ ! -e "$scratch/fresh-launched" ]]
      grep -Fq FARMD_BUILD_SUBJECT_INVALID "$scratch/output" ;;
  esac
  passed=$((passed + 1))
done
done
printf '[ci] farmd private build target fixtures: %s passed\n' "$passed"
