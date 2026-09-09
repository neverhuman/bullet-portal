#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
fixture="$sandbox/repo"
bin="$fixture/bin"
mkdir -p "$bin" "$fixture/node_modules" "$fixture/ops/ci" "$fixture/scripts"
cp ops/ci/lib.sh "$fixture/ops/ci/lib.sh"
cp scripts/ci-doctor.sh "$fixture/scripts/ci-doctor.sh"

write_version_tool() {
  local name="$1" version="$2"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "%s"\n' "$version" >"$bin/$name"
  chmod 700 "$bin/$name"
}

check_library() {
  PATH="$bin:$PATH" bash -c 'set -euo pipefail; source "$1"; require_node_floor' \
    portal-toolchain-test "$fixture/ops/ci/lib.sh"
}

check_doctor() {
  PATH="$bin:$PATH" bash "$fixture/scripts/ci-doctor.sh" fast
}

expect_refusal() {
  local label="$1" node_version="$2" npm_version="$3"
  local output="$sandbox/$label.log"
  write_version_tool node "$node_version"
  write_version_tool npm "$npm_version"
  if check_library >"$output" 2>&1; then
    printf '[ci] %s: lib accepted the wrong toolchain\n' "$label" >&2
    exit 1
  fi
  grep -Fq 'PORTAL_TOOLCHAIN_VERSION_MISMATCH' "$output"
  if check_doctor >"$output" 2>&1; then
    printf '[ci] %s: doctor accepted the wrong toolchain\n' "$label" >&2
    exit 1
  fi
  grep -Fq 'PORTAL_TOOLCHAIN_VERSION_MISMATCH' "$output"
}

write_version_tool node v22.23.2
write_version_tool npm 10.9.8
check_library >/dev/null
check_doctor >/dev/null
expect_refusal wrong-node v22.23.3 10.9.8
expect_refusal wrong-npm v22.23.2 10.9.9
printf '[ci] exact Node/npm identity and two wrong-version refusals passed\n'
