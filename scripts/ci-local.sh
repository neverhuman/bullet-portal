#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# bullet-member-proof-custody-v1

readonly CI_PROOF_REPOSITORY="bullet-portal"
readonly CI_PROOF_LOCK_DIR="$PWD/.git/bullet-ci.lock.d"
readonly CI_PROOF_LOCK_OWNER="$CI_PROOF_LOCK_DIR/owner"
CI_PROOF_LOCK_RECORD=""
CI_PROOF_LOCK_SCOPE=""
CI_SOURCE_MONITOR_PID=""
CI_SOURCE_MONITOR_RUNNING=false
CI_SOURCE_TERMINATION_UNKNOWN=false
CI_SOURCE_CONFIG=""
CI_SOURCE_RESPONSE_SECONDS=60

# Observational Git and npm use explicit configuration; ambient executable
# injection is rejected by source admission before any proof lane runs.
export GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
# npm refuses loading the same path as both user and global configuration.
# These distinct, tracked inputs are bound by the source monitor.
unset npm_config_userconfig npm_config_globalconfig
export NPM_CONFIG_USERCONFIG="$PWD/ops/ci/npm-userconfig.npmrc"
export NPM_CONFIG_GLOBALCONFIG="$PWD/ops/ci/npm-globalconfig.npmrc"

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
  if [[ -n "$CI_SOURCE_CONFIG" && -f "$CI_SOURCE_CONFIG" && ! -L "$CI_SOURCE_CONFIG" ]]; then
    rm -- "$CI_SOURCE_CONFIG" || return 75
  fi
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
    required) BULLET_CI_OBSERVATION_OWNER="$CI_PROOF_LOCK_RECORD" bash ops/ci/required.sh ;;
    fast)     bash ops/ci/fast.sh ;;
    lint)     bash ops/ci/lint.sh ;;
    contract) bash ops/ci/contract.sh ;;
    rendered) bash ops/ci/rendered.sh ;;
    security) bash ops/ci/security.sh ;;
    docs)     bash ops/ci/docs.sh ;;
    family)   bash ops/ci/family.sh ;;
    nightly)  bash ops/ci/nightly.sh ;;
    packaged-farmd) bash ops/ci/packaged-farmd.sh ;;
    coverage) bash ops/ci/coverage.sh ;;
    scheduled-hygiene) bash ops/ci/scheduled-hygiene.sh ;;
    portable) bash ops/ci/portable.sh ;;
    audit)    bash ops/ci/audit.sh ;;
    gates|all) BULLET_CI_OBSERVATION_OWNER="$CI_PROOF_LOCK_RECORD" bash ops/ci/required.sh ;;
    *)
      echo "usage: $0 {required|fast|lint|contract|rendered|security|docs|family|coverage|scheduled-hygiene|portable|audit|nightly|packaged-farmd|all}" >&2
      return 2
      ;;
  esac
}

observation_operation() {
  BULLET_CI_OBSERVATION_OWNER="$CI_PROOF_LOCK_RECORD" \
    timeout --kill-after=2s "${CI_SOURCE_RESPONSE_SECONDS}s" node ops/ci/observation.mjs "$@"
}

source_control() {
  timeout --kill-after=2s "${CI_SOURCE_RESPONSE_SECONDS}s" node ops/ci/source-custody.mjs "$@"
}

stop_source_monitor() {
  if [[ "$CI_SOURCE_MONITOR_RUNNING" == true ]]; then
    if source_control terminate; then
      wait "$CI_SOURCE_MONITOR_PID" 2>/dev/null || true
      CI_SOURCE_MONITOR_RUNNING=false
    else
      CI_SOURCE_TERMINATION_UNKNOWN=true
      echo 'ci-local: MONITOR_TERMINATION_UNKNOWN: retained proof lock; no integer-PID signal fallback' >&2
    fi
  fi
  exec 8<&- 9>&-
}

start_source_monitor() {
  local lane="$1" settings monitor_binary process_stat
  local -a fields
  [[ "$(uname -s)" == Linux ]] || {
    echo 'ci-local: SOURCE_MONITOR_UNAVAILABLE: native Linux custody required' >&2
    return 72
  }
  command -v timeout >/dev/null || {
    echo 'ci-local: SOURCE_MONITOR_UNAVAILABLE: bounded timeout tool required' >&2
    return 72
  }
  export BULLET_CI_SOURCE_OWNER_PID="$$"
  if [[ -z "${BULLET_CI_SOURCE_ADMISSION:-}" && -n "${BULLET_CI_SOURCE_POLICY:-}" ]]; then
    settings="$(source_control bootstrap "$lane")" || return $?
    mapfile -t fields <<<"$settings"
    [[ "${#fields[@]}" -eq 3 ]] || return 75
    export BULLET_CI_SOURCE_ADMISSION="${fields[0]}" BULLET_CI_SOURCE_ADMISSION_SHA256="${fields[1]}"
    export PATH="${fields[2]}"
  fi
  settings="$(source_control configure "$lane" "$CI_PROOF_LOCK_OWNER")" || return $?
  mapfile -t fields <<<"$settings"
  [[ "${#fields[@]}" -eq 4 ]] || return 75
  export BULLET_CI_SOURCE_SESSION="${fields[0]}"
  CI_SOURCE_CONFIG="${fields[1]}"
  monitor_binary="${fields[2]}"
  CI_SOURCE_RESPONSE_SECONDS="${fields[3]}"
  export BULLET_CI_SOURCE_RESPONSE_SECONDS="$CI_SOURCE_RESPONSE_SECONDS"
  coproc PROOF_MONITOR { exec "$monitor_binary" "$CI_SOURCE_CONFIG" \
    2>"$BULLET_CI_SOURCE_SESSION/monitor.stderr"; }
  CI_SOURCE_MONITOR_PID="$PROOF_MONITOR_PID"
  CI_SOURCE_MONITOR_RUNNING=true
  export BULLET_CI_SOURCE_MONITOR_PID="$CI_SOURCE_MONITOR_PID"
  # Capture the owned child's start identity immediately, including before READY.
  # Cleanup uses a pidfd and never signals this integer PID directly.
  if IFS= read -r process_stat <"/proc/$CI_SOURCE_MONITOR_PID/stat"; then
    read -r -a fields <<<"${process_stat##*) }"
    if [[ "${fields[1]:-}" == "$$" && "${fields[19]:-}" =~ ^[0-9]+$ ]]; then
      export BULLET_CI_SOURCE_MONITOR_START="${fields[19]}"
    else return 75; fi
  else return 75; fi
  # Bash preserves CLOEXEC on duplicated coprocess descriptors. Reopen these
  # exact live pipe endpoints so sequential child helpers inherit them.
  exec 8<"/proc/$$/fd/${PROOF_MONITOR[0]}" 9>"/proc/$$/fd/${PROOF_MONITOR[1]}" || return 75
  export BULLET_CI_SOURCE_READ_FD=8 BULLET_CI_SOURCE_WRITE_FD=9
  source_control READY
}

wait_source_monitor() {
  local waited=0 status
  while kill -0 "$CI_SOURCE_MONITOR_PID" 2>/dev/null; do
    if (( waited >= CI_SOURCE_RESPONSE_SECONDS * 10 )); then
      echo 'ci-local: MONITOR_FINAL_EXIT_DEADLINE' >&2
      stop_source_monitor
      return 75
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  if wait "$CI_SOURCE_MONITOR_PID"; then status=0; else status=$?; fi
  CI_SOURCE_MONITOR_RUNNING=false
  exec 8<&- 9>&-
  return "$status"
}

verify_current_custody() {
  if [[ "$CI_PROOF_LOCK_SCOPE" == "family" ]]; then
    verify_proof_lock "$CI_PROOF_LOCK_RECORD" family "$PPID"
  else
    verify_proof_lock "$CI_PROOF_LOCK_RECORD" standalone "$$" "$1"
  fi
}

run_with_proof_custody() {
  local lane="$1" status=0 inherited_record="" inherited_present=false
  local lifecycle=false generation="" outcome seal_status monitor_status=0 custody_status=0 child_status=0
  if [[ ${BULLET_CI_PROOF_CUSTODY+x} ]]; then
    inherited_present=true
    inherited_record="$BULLET_CI_PROOF_CUSTODY"
  fi
  unset BULLET_CI_PROOF_CUSTODY BULLET_CI_OBSERVATION_OWNER
  unset BULLET_CI_SOURCE_SESSION BULLET_CI_SOURCE_MONITOR_PID BULLET_CI_SOURCE_OWNER_PID
  unset BULLET_CI_SOURCE_MONITOR_START
  unset BULLET_CI_SOURCE_READ_FD BULLET_CI_SOURCE_WRITE_FD BULLET_CI_SOURCE_RESPONSE_SECONDS
  export BULLET_CI_SOURCE_CHILD_STARTED=false

  case "$lane" in
    rendered|family|nightly|packaged-farmd)
      node --input-type=module -e 'import { requireRenderedHost } from "./ops/proof/rendered-host.ts"; requireRenderedHost();' || return $?
      ;;
  esac

  [[ "$lane" =~ ^[a-z0-9-]+$ ]] || {
    proof_lock_refusal
    return 75
  }
  if [[ "$inherited_present" == true ]]; then
    adopt_family_proof_lock "$inherited_record" || return $?
  else
    acquire_proof_lock "$lane" || return $?
  fi

  # The lock is held across READY, every stage, final read-back, FINISHED and
  # observed monitor exit. A receipt file alone never bypasses this generation.
  trap stop_source_monitor EXIT
  if start_source_monitor "$lane"; then :; else status=$?; fi

  case "$lane" in
    fast|lint|contract|rendered|security|docs|coverage|scheduled-hygiene|portable) lifecycle=true ;;
  esac
  if [[ "$status" -eq 0 && "$lifecycle" == true ]]; then
    generation="$(observation_operation prepare "$lane")" || status=$?
  fi
  if [[ "$status" -eq 0 ]]; then
    export BULLET_CI_SOURCE_CHILD_STARTED=true
    if dispatch_lane "$lane"; then status=0; else status=$?; fi
    child_status="$status"
    verify_current_custody "$lane" || custody_status=$?
    if [[ "$lifecycle" == true ]]; then
      outcome=failure
      [[ "$status" -ne 0 ]] || outcome=success
      if observation_operation seal "$lane" "$generation" "$outcome" "$status"; then
        :
      else
        seal_status=$?
        [[ "$status" -ne 0 ]] || status="$seal_status"
      fi
    fi
  fi

  if [[ -n "${BULLET_CI_SOURCE_SESSION:-}" && "$custody_status" -eq 0 ]]; then
    observation_operation readback || monitor_status=$?
    if [[ "$monitor_status" -eq 0 ]]; then source_control FINISH || monitor_status=$?; fi
    if [[ "$monitor_status" -eq 0 ]]; then wait_source_monitor || monitor_status=$?; fi
    if [[ "$monitor_status" -eq 0 ]]; then
      observation_operation publish "$child_status" 0 || monitor_status=$?
    fi
  else
    monitor_status=75
  fi
  if [[ "$monitor_status" -ne 0 || "$custody_status" -ne 0 ]]; then
    stop_source_monitor
    if [[ -n "${BULLET_CI_SOURCE_SESSION:-}" ]]; then
      source_control refuse "$child_status" "$monitor_status" 'source custody or final acceptance failed' || true
      observation_operation invalidate || true
      [[ ! -f "$BULLET_CI_SOURCE_SESSION/monitor.stderr" ]] || \
        while IFS= read -r diagnostic; do printf '%s\n' "$diagnostic" >&2; done <"$BULLET_CI_SOURCE_SESSION/monitor.stderr"
    fi
    [[ "$status" -ne 0 ]] || status=75
  fi
  [[ "$custody_status" -eq 0 ]] || return "$custody_status"
  [[ "$CI_SOURCE_TERMINATION_UNKNOWN" == false ]] || return 75

  if [[ "$CI_PROOF_LOCK_SCOPE" == "family" ]]; then
    verify_proof_lock "$CI_PROOF_LOCK_RECORD" family "$PPID" || return $?
    if [[ -n "$CI_SOURCE_CONFIG" && -f "$CI_SOURCE_CONFIG" && ! -L "$CI_SOURCE_CONFIG" ]]; then
      rm -- "$CI_SOURCE_CONFIG" || return 75
    fi
  else
    release_proof_lock "$lane" || return $?
  fi
  trap - EXIT
  return "$status"
}

run_with_proof_custody "${1:-required}"
