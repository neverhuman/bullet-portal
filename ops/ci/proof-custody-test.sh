#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=ops/ci/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

TEST_ROOT="$(mktemp -d)"
ACTIVE_DISPATCHER_PID=""
ORPHAN_PID=""
cleanup() {
  if [[ -n "$ACTIVE_DISPATCHER_PID" ]] && kill -0 "$ACTIVE_DISPATCHER_PID" 2>/dev/null; then
    kill -KILL "$ACTIVE_DISPATCHER_PID" 2>/dev/null || true
  fi
  if [[ -n "$ORPHAN_PID" ]] && kill -0 "$ORPHAN_PID" 2>/dev/null; then
    kill -KILL "$ORPHAN_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  printf '[ci] proof custody fixture failed: %s\n' "$*" >&2
  exit 1
}

line_count() {
  [[ -f "$1" ]] && wc -l <"$1" || printf '0\n'
}

wait_for() {
  local path="$1"
  for _ in {1..200}; do
    [[ -e "$path" ]] && return 0
    sleep 0.02
  done
  fail "timed out waiting for $path"
}

new_fixture() {
  local repo="$TEST_ROOT/$1"
  mkdir -p "$repo/scripts" "$repo/ops/ci" "$repo/.git"
  chmod 700 "$repo/.git"
  printf 'ref: refs/heads/main\n' >"$repo/.git/HEAD"
  cp "$REPO_ROOT/scripts/ci-local.sh" "$repo/scripts/ci-local.sh"
  cat >"$repo/ops/ci/fast.sh" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
[[ ! ${BULLET_CI_PROOF_CUSTODY+x} ]] || exit 90
printf 'child\n' >>"$FIXTURE_CHILD_LOG"
if [[ "${FIXTURE_NESTED:-}" == "1" ]]; then
  set +e
  nested_output="$(FIXTURE_NESTED= bash scripts/ci-local.sh fast 2>&1)"
  nested_status=$?
  set -e
  [[ "$nested_status" -eq 75 && "$nested_output" == *CI_PROOF_LOCKED_OR_STALE* ]] || exit 91
fi
if [[ "${FIXTURE_HOLD:-}" == "1" ]]; then
  printf '%s\n' "$$" >"$FIXTURE_LANE_PID"
  : >"$FIXTURE_READY"
  trap 'exit 143' TERM INT
  while [[ ! -e "$FIXTURE_RELEASE" ]]; do sleep 0.02; done
fi
if [[ -n "${FIXTURE_MODE_REPORT:-}" ]]; then
  dir_mode="$(stat -c '%a' .git/bullet-ci.lock.d)"
  owner_mode="$(stat -c '%a' .git/bullet-ci.lock.d/owner)"
  printf '%s %s\n' "$dir_mode" "$owner_mode" >"$FIXTURE_MODE_REPORT"
fi
if [[ "${FIXTURE_WRITE_REPORT:-1}" == "1" ]]; then
  printf 'report\n' >"$FIXTURE_REPORT"
fi
exit "${FIXTURE_STATUS:-0}"
FIXTURE
  chmod +x "$repo/scripts/ci-local.sh" "$repo/ops/ci/fast.sh"
  printf '%s\n' "$repo"
}

run_dispatcher() {
  local repo="$1"
  shift
  (cd "$repo" && env "$@" bash scripts/ci-local.sh fast)
}

write_owner() {
  local repo="$1" record="$2" dir_mode="${3:-700}" owner_mode="${4:-600}"
  mkdir "$repo/.git/bullet-ci.lock.d"
  chmod "$dir_mode" "$repo/.git/bullet-ci.lock.d"
  printf '%s\n' "$record" >"$repo/.git/bullet-ci.lock.d/owner"
  chmod "$owner_mode" "$repo/.git/bullet-ci.lock.d/owner"
}

assert_parent_record_refused() {
  local name="$1" record="$2" hostile_suffix="${3:-none}"
  local repo output status before_children before_bytes after_bytes
  repo="$(new_fixture "$name")"
  printf 'outside\n' >"$repo/outside"
  printf 'original\n' >"$repo/report"
  write_owner "$repo" "$record"
  case "$hostile_suffix" in
    none) ;;
    extra-line) printf '\n' >>"$repo/.git/bullet-ci.lock.d/owner" ;;
    nul) printf '\0' >>"$repo/.git/bullet-ci.lock.d/owner" ;;
    *) fail "unknown hostile owner suffix: $hostile_suffix" ;;
  esac
  before_children="$(line_count "$repo/child.log")"
  before_bytes="$(wc -c <"$repo/.git/bullet-ci.lock.d/owner")"
  set +e
  output="$(run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$record" \
    FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" 2>&1)"
  status=$?
  set -e
  after_bytes="$(wc -c <"$repo/.git/bullet-ci.lock.d/owner")"
  [[ "$status" -eq 75 && "$output" == *CI_PROOF_LOCKED_OR_STALE* \
    && "$(line_count "$repo/child.log")" -eq "$before_children" \
    && "$after_bytes" -eq "$before_bytes" \
    && "$(<"$repo/report")" == original && "$(<"$repo/outside")" == outside ]] || \
    fail "$name record reached a child or mutated sentinels"
}

repo="$(new_fixture standalone-pass)"
run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" \
  FIXTURE_STATUS=0 >/dev/null 2>&1 || fail "standalone PASS refused"
[[ -f "$repo/report" && "$(line_count "$repo/child.log")" -eq 1 \
  && ! -e "$repo/.git/bullet-ci.lock.d" ]] || fail "standalone PASS did not release"

repo="$(new_fixture standalone-fail)"
set +e
run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" \
  FIXTURE_STATUS=19 >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 19 && "$(line_count "$repo/child.log")" -eq 1 \
  && ! -e "$repo/.git/bullet-ci.lock.d" ]] || fail "standalone FAIL did not release"

repo="$(new_fixture invalid-lane)"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
set +e
output="$(cd "$repo" && env FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" \
  bash scripts/ci-local.sh 'FAST_bad' 2>&1)"
status=$?
set -e
[[ "$status" -eq 75 && "$output" == *CI_PROOF_LOCKED_OR_STALE* \
  && ! -e "$repo/.git/bullet-ci.lock.d" && ! -e "$repo/child.log" \
  && "$(<"$repo/report")" == original && "$(<"$repo/outside")" == outside ]] || \
  fail "invalid lane mutated custody before refusal"

repo="$(new_fixture inherited-empty)"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
set +e
output="$(run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY= FIXTURE_CHILD_LOG="$repo/child.log" \
  FIXTURE_REPORT="$repo/report" 2>&1)"
status=$?
set -e
[[ "$status" -eq 75 && "$output" == *CI_PROOF_LOCKED_OR_STALE* \
  && ! -e "$repo/.git/bullet-ci.lock.d" && ! -e "$repo/child.log" \
  && "$(<"$repo/report")" == original && "$(<"$repo/outside")" == outside ]] || \
  fail "present-empty inherited custody fell back to standalone"

repo="$(new_fixture overlap)"
record="schema=2 repository=bullet-portal scope=standalone pid=$$ lane=fast nonce=1-2-3-4"
write_owner "$repo" "$record"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
set +e
output="$(run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" 2>&1)"
status=$?
set -e
[[ "$status" -eq 75 && "$output" == *CI_PROOF_LOCKED_OR_STALE* \
  && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside ]] || fail "overlap mutated fixture"

for family_lane in family family-contract; do
  repo="$(new_fixture "borrowed-$family_lane")"
  record="schema=2 repository=bullet-portal scope=family pid=$$ lane=$family_lane nonce=1-2-3-4"
  write_owner "$repo" "$record"
  run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$record" FIXTURE_CHILD_LOG="$repo/child.log" \
    FIXTURE_REPORT="$repo/report" FIXTURE_NESTED=1 >/dev/null 2>&1 || \
    fail "borrowed $family_lane custody refused"
  [[ -d "$repo/.git/bullet-ci.lock.d" && ! -L "$repo/.git/bullet-ci.lock.d" \
    && -f "$repo/.git/bullet-ci.lock.d/owner" && ! -L "$repo/.git/bullet-ci.lock.d/owner" \
    && "$(<"$repo/.git/bullet-ci.lock.d/owner")" == "$record" \
    && "$(line_count "$repo/child.log")" -eq 1 ]] || \
    fail "borrower released owner, leaked custody, or allowed nested child"
done

base_record="schema=2 repository=bullet-portal scope=family pid=$$ lane=family nonce=1-2-3-4"
assert_parent_record_refused wrong-repository \
  "${base_record/repository=bullet-portal/repository=bullet-kernel}"
assert_parent_record_refused wrong-scope \
  "${base_record/scope=family/scope=standalone}"
assert_parent_record_refused wrong-pid \
  "${base_record/pid=$$/pid=$(( $$ + 1 ))}"
assert_parent_record_refused wrong-family-lane \
  "${base_record/lane=family/lane=required}"
assert_parent_record_refused nonnumeric-nonce \
  "${base_record/nonce=1-2-3-4/nonce=not-numeric}"
assert_parent_record_refused owner-extra-line "$base_record" extra-line
assert_parent_record_refused owner-nul "$base_record" nul

repo="$(new_fixture owner-mismatch)"
write_owner "$repo" "$base_record"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
forged="${base_record/nonce=1-2-3-4/nonce=9-9-9-9}"
set +e
output="$(run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$forged" \
  FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" 2>&1)"
status=$?
set -e
[[ "$status" -eq 75 && "$output" == *CI_PROOF_LOCKED_OR_STALE* \
  && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside && "$(<"$repo/.git/bullet-ci.lock.d/owner")" == "$base_record" ]] || \
  fail "mismatched inherited bytes reached child or mutated sentinels"

repo="$(new_fixture replay)"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
set +e
output="$(run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$base_record" \
  FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" 2>&1)"
status=$?
set -e
[[ "$status" -eq 75 && "$output" == *CI_PROOF_LOCKED_OR_STALE* \
  && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside ]] || fail "released owner record was replayed"

repo="$(new_fixture missing-head)"
rm "$repo/.git/HEAD"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
set +e
run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 75 && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside ]] || fail "missing HEAD changed sentinels"

repo="$(new_fixture head-symlink)"
rm "$repo/.git/HEAD"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
ln -s "$repo/outside" "$repo/.git/HEAD"
record="schema=2 repository=bullet-portal scope=family pid=$$ lane=family nonce=1-2-3-4"
write_owner "$repo" "$record"
set +e
run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$record" FIXTURE_CHILD_LOG="$repo/child.log" \
  FIXTURE_REPORT="$repo/report" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 75 && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside ]] || fail "symlink HEAD changed sentinels"

repo="$(new_fixture git-symlink)"
mkdir "$repo/outside-dir"
printf 'outside\n' >"$repo/outside-dir/sentinel"
printf 'original\n' >"$repo/report"
rm "$repo/.git/HEAD"
rmdir "$repo/.git"
ln -s "$repo/outside-dir" "$repo/.git"
set +e
run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 75 && ! -e "$repo/child.log" && ! -e "$repo/outside-dir/bullet-ci.lock.d" \
  && "$(<"$repo/report")" == original && "$(<"$repo/outside-dir/sentinel")" == outside ]] || \
  fail ".git symlink changed outside or report sentinel"

repo="$(new_fixture lock-symlink)"
mkdir "$repo/outside-dir"
printf 'outside\n' >"$repo/outside-dir/sentinel"
printf 'original\n' >"$repo/report"
ln -s "$repo/outside-dir" "$repo/.git/bullet-ci.lock.d"
set +e
run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 75 && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside-dir/sentinel")" == outside && ! -e "$repo/outside-dir/owner" ]] || \
  fail "lock symlink changed outside or report sentinel"

repo="$(new_fixture owner-symlink)"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
mkdir "$repo/.git/bullet-ci.lock.d"
chmod 700 "$repo/.git/bullet-ci.lock.d"
ln -s "$repo/outside" "$repo/.git/bullet-ci.lock.d/owner"
record="schema=2 repository=bullet-portal scope=family pid=$$ lane=family nonce=1-2-3-4"
set +e
run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$record" FIXTURE_CHILD_LOG="$repo/child.log" \
  FIXTURE_REPORT="$repo/report" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 75 && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside && -L "$repo/.git/bullet-ci.lock.d/owner" ]] || \
  fail "owner symlink was followed"

repo="$(new_fixture wrong-mode)"
record="schema=2 repository=bullet-portal scope=family pid=$$ lane=family nonce=1-2-3-4"
write_owner "$repo" "$record" 755 644
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
set +e
run_dispatcher "$repo" BULLET_CI_PROOF_CUSTODY="$record" FIXTURE_CHILD_LOG="$repo/child.log" \
  FIXTURE_REPORT="$repo/report" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 75 && ! -e "$repo/child.log" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside ]] || fail "wrong owner modes were accepted"

repo="$(new_fixture hostile-umask)"
(umask 000; run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" \
  FIXTURE_MODE_REPORT="$repo/modes") >/dev/null 2>&1 || fail "hostile umask run refused"
[[ "$(<"$repo/modes")" == "700 600" && ! -e "$repo/.git/bullet-ci.lock.d" ]] || \
  fail "hostile umask changed custody modes"

repo="$(new_fixture post-child-substitution)"
printf 'outside\n' >"$repo/outside"
printf 'original\n' >"$repo/report"
(
  cd "$repo"
  record="schema=2 repository=bullet-portal scope=family pid=${BASHPID:-$$} lane=family nonce=1-2-3-4"
  (umask 077; mkdir .git/bullet-ci.lock.d; printf '%s\n' "$record" >.git/bullet-ci.lock.d/owner)
  set +e
  env BULLET_CI_PROOF_CUSTODY="$record" FIXTURE_CHILD_LOG="$repo/child.log" \
    FIXTURE_REPORT="$repo/report" FIXTURE_WRITE_REPORT=0 FIXTURE_HOLD=1 \
    FIXTURE_READY="$repo/ready" FIXTURE_LANE_PID="$repo/lane.pid" FIXTURE_RELEASE="$repo/release" \
    bash scripts/ci-local.sh fast
  child_status=$?
  set -e
  if [[ "$child_status" -eq 0 ]]; then
    printf 'published\n' >"$repo/publication"
  fi
  exit "$child_status"
) >"$repo/dispatcher.output" 2>&1 &
ACTIVE_DISPATCHER_PID=$!
wait_for "$repo/ready"
rm "$repo/.git/bullet-ci.lock.d/owner"
ln -s "$repo/outside" "$repo/.git/bullet-ci.lock.d/owner"
: >"$repo/release"
set +e
wait "$ACTIVE_DISPATCHER_PID"
status=$?
set -e
ACTIVE_DISPATCHER_PID=""
[[ "$status" -eq 75 && "$(line_count "$repo/child.log")" -eq 1 \
  && ! -e "$repo/publication" && "$(<"$repo/report")" == original \
  && "$(<"$repo/outside")" == outside && -L "$repo/.git/bullet-ci.lock.d/owner" ]] || \
  fail "post-child owner substitution reached publication or changed sentinels"

repo="$(new_fixture crash-stale)"
run_dispatcher "$repo" FIXTURE_CHILD_LOG="$repo/child.log" FIXTURE_REPORT="$repo/report" \
  FIXTURE_HOLD=1 FIXTURE_READY="$repo/ready" FIXTURE_LANE_PID="$repo/lane.pid" \
  FIXTURE_RELEASE="$repo/release" >/dev/null 2>&1 &
ACTIVE_DISPATCHER_PID=$!
wait_for "$repo/ready"
ORPHAN_PID="$(<"$repo/lane.pid")"
kill -KILL "$ACTIVE_DISPATCHER_PID"
set +e
wait "$ACTIVE_DISPATCHER_PID" 2>/dev/null
set -e
ACTIVE_DISPATCHER_PID=""
[[ -d "$repo/.git/bullet-ci.lock.d" ]] || fail "dispatcher crash did not leave stale custody"
kill -TERM "$ORPHAN_PID" 2>/dev/null || true
for _ in {1..100}; do
  kill -0 "$ORPHAN_PID" 2>/dev/null || break
  sleep 0.02
done
if kill -0 "$ORPHAN_PID" 2>/dev/null; then
  kill -KILL "$ORPHAN_PID" 2>/dev/null || true
  for _ in {1..100}; do
    kill -0 "$ORPHAN_PID" 2>/dev/null || break
    sleep 0.02
  done
fi
kill -0 "$ORPHAN_PID" 2>/dev/null && fail "fixture orphan survived bounded cleanup"
ORPHAN_PID=""

log "proof custody fixture passed"
