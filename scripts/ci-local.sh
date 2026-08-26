#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# bullet-member-proof-custody-v1

readonly CI_PROOF_REPOSITORY="bullet-portal"
readonly CI_PROOF_LOCK_DIR="$PWD/.git/bullet-ci.lock.d"
readonly CI_PROOF_LOCK_OWNER="$CI_PROOF_LOCK_DIR/owner"
CI_PROOF_LOCK_RECORD=""
CI_PROOF_LOCK_SCOPE=""

proof_lock_refusal() {
  printf '%s\n' \
    "ci-local: CI_PROOF_LOCKED_OR_STALE: $CI_PROOF_LOCK_DIR is occupied or cannot be trusted" \
    "ci-local: verify that no scripts/ci-local.sh or family proof process owns this exact checkout; then inspect and explicitly reconcile only $CI_PROOF_LOCK_DIR" >&2
  return 75
}

subject_mode() {
  local mode
  if mode="$(stat -c '%a' -- "$1" 2>/dev/null)"; then
    printf '%s\n' "$mode"
    return 0
  fi
  stat -f '%Lp' -- "$1" 2>/dev/null
}

read_exact_owner() {
  local record byte_count expected_bytes
  [[ -d "$PWD/.git" && ! -L "$PWD/.git" \
    && -f "$PWD/.git/HEAD" && ! -L "$PWD/.git/HEAD" \
    && -d "$CI_PROOF_LOCK_DIR" && ! -L "$CI_PROOF_LOCK_DIR" && -O "$CI_PROOF_LOCK_DIR" \
    && "$(subject_mode "$CI_PROOF_LOCK_DIR")" == "700" \
    && -f "$CI_PROOF_LOCK_OWNER" && ! -L "$CI_PROOF_LOCK_OWNER" && -O "$CI_PROOF_LOCK_OWNER" \
    && "$(subject_mode "$CI_PROOF_LOCK_OWNER")" == "600" ]] || return 1
  IFS= read -r record <"$CI_PROOF_LOCK_OWNER" || return 1
  byte_count="$(LC_ALL=C wc -c <"$CI_PROOF_LOCK_OWNER")" || return 1
  expected_bytes=$((${#record} + 1))
  [[ "$byte_count" -eq "$expected_bytes" ]] || return 1
  printf '%s\n' "$record"
}

verify_proof_lock() {
  local expected_record="$1" expected_scope="$2" expected_pid="$3" expected_lane="${4:-}"
  local record repository scope pid lane nonce
  record="$(read_exact_owner)" || {
    proof_lock_refusal
    return 75
  }
  [[ "$record" == "$expected_record" \
    && "$record" =~ ^schema=2\ repository=([a-z0-9-]+)\ scope=(standalone|family)\ pid=([1-9][0-9]*)\ lane=([a-z0-9-]+)\ nonce=([0-9]+-[0-9]+-[0-9]+-[0-9]+)$ ]] || {
    proof_lock_refusal
    return 75
  }
  repository="${BASH_REMATCH[1]}"
  scope="${BASH_REMATCH[2]}"
  pid="${BASH_REMATCH[3]}"
  lane="${BASH_REMATCH[4]}"
  nonce="${BASH_REMATCH[5]}"
  [[ "$repository" == "$CI_PROOF_REPOSITORY" && "$scope" == "$expected_scope" \
    && "$pid" == "$expected_pid" && -n "$nonce" ]] || {
    proof_lock_refusal
    return 75
  }
  if [[ "$expected_scope" == "family" ]]; then
    [[ "$lane" == "family" || "$lane" == "family-contract" ]] || {
      proof_lock_refusal
      return 75
    }
  else
    [[ -n "$expected_lane" && "$lane" == "$expected_lane" ]] || {
      proof_lock_refusal
      return 75
    }
  fi
}

acquire_proof_lock() {
  local lane="$1"
  [[ -d "$PWD/.git" && ! -L "$PWD/.git" \
    && -f "$PWD/.git/HEAD" && ! -L "$PWD/.git/HEAD" ]] || {
    proof_lock_refusal
    return 75
  }
  if ! (umask 077; mkdir -- "$CI_PROOF_LOCK_DIR") 2>/dev/null; then
    proof_lock_refusal
    return 75
  fi
  CI_PROOF_LOCK_RECORD="schema=2 repository=$CI_PROOF_REPOSITORY scope=standalone pid=$$ lane=$lane nonce=$$-${BASHPID:-$$}-$RANDOM-$RANDOM"
  if ! (umask 077; set -o noclobber; printf '%s\n' "$CI_PROOF_LOCK_RECORD" \
      >"$CI_PROOF_LOCK_OWNER") 2>/dev/null; then
    proof_lock_refusal
    return 75
  fi
  verify_proof_lock "$CI_PROOF_LOCK_RECORD" standalone "$$" "$lane" || return $?
  CI_PROOF_LOCK_SCOPE="standalone"
}

adopt_family_proof_lock() {
  local inherited_record="$1"
  [[ -n "$inherited_record" ]] || {
    proof_lock_refusal
    return 75
  }
  CI_PROOF_LOCK_RECORD="$inherited_record"
  verify_proof_lock "$CI_PROOF_LOCK_RECORD" family "$PPID" || return $?
  CI_PROOF_LOCK_SCOPE="family"
}

release_proof_lock() {
  verify_proof_lock "$CI_PROOF_LOCK_RECORD" standalone "$$" "$1" || return $?
  rm -- "$CI_PROOF_LOCK_OWNER" || {
    proof_lock_refusal
    return 75
  }
  rmdir -- "$CI_PROOF_LOCK_DIR" || {
    proof_lock_refusal
    return 75
  }
}

dispatch_lane() {
  local lane="$1"
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
    *)
      echo "usage: $0 {required|fast|lint|contract|security|docs|family|coverage|scheduled-hygiene|portable|audit|nightly|packaged-farmd|all}" >&2
      return 2
      ;;
  esac
}

run_with_proof_custody() {
  local lane="$1" status inherited_record="" inherited_present=false
  if [[ ${BULLET_CI_PROOF_CUSTODY+x} ]]; then
    inherited_present=true
    inherited_record="$BULLET_CI_PROOF_CUSTODY"
  fi
  unset BULLET_CI_PROOF_CUSTODY

  [[ "$lane" =~ ^[a-z0-9-]+$ ]] || {
    proof_lock_refusal
    return 75
  }
  if [[ "$inherited_present" == true ]]; then
    adopt_family_proof_lock "$inherited_record" || return $?
  else
    acquire_proof_lock "$lane" || return $?
  fi

  if dispatch_lane "$lane"; then
    status=0
  else
    status=$?
  fi

  if [[ "$CI_PROOF_LOCK_SCOPE" == "family" ]]; then
    verify_proof_lock "$CI_PROOF_LOCK_RECORD" family "$PPID" || return $?
  else
    release_proof_lock "$lane" || return $?
  fi
  return "$status"
}

run_with_proof_custody "${1:-required}"
