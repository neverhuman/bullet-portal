#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool gitleaks || exit 1
require_tool node || exit 1
[[ "$(gitleaks version)" == "8.21.2" ]] || {
  echo "[ci] gitleaks 8.21.2 required" >&2
  exit 1
}
policy="$REPO_ROOT/ops/ci/gitleaks.toml"

umask 077
canary_dir="$(mktemp -d)"
finish() {
  rm -rf -- "$canary_dir"
}
trap finish EXIT
passed=()

assert_scan() {
  local identity="$1" expected_exit="$2" rule="$3" input="$4" status=0
  local subject="$canary_dir/$identity"
  mkdir "$subject"
  printf '%s\n' "$input" >"$subject/canary.txt"
  gitleaks detect --source "$subject" --no-git --redact --no-banner \
    --config "$policy" --report-format json \
    --report-path "$canary_dir/$identity.json" \
    >"$canary_dir/$identity.log" 2>&1 || status=$?
  if [[ "$status" != "$expected_exit" ]]; then
    cat "$canary_dir/$identity.log" >&2
    echo "[ci] SECRET_CANARY_FAILED: $identity unexpected scanner exit $status" >&2
    exit 1
  fi
  # A configuration/tool failure is never detector success. The admitted label
  # requires an empty report; negative cases require the exact finding kind.
  node --input-type=module - "$canary_dir/$identity.json" "$rule" "$subject/canary.txt" "$identity" <<'NODE'
import { readFileSync } from "node:fs";
const [path, rule, file, identity] = process.argv.slice(2);
const findings = JSON.parse(readFileSync(path, "utf8"));
if (!Array.isArray(findings) || (rule === "none"
  ? findings.length !== 0
  : findings.length !== 1 || findings[0].RuleID !== rule ||
    findings[0].File !== file || findings[0].StartLine !== 1)) {
  throw new Error(`SECRET_CANARY_FAILED: ${identity} scanner report differs from expected finding`);
}
NODE
  passed+=("$identity")
}

# Split the fake value in committed source so the repository scan remains clean;
# only the disposable canary file contains the detector-shaped string.
credential="$(printf '%s%s' 'ghp_' '1234567890abcdefghijklmnopqrstuvwxyz')"
public_label="$(printf '%s%s' 'verification-intent-' 'fixture-1')"
assert_scan public_label 0 none "{\"key_id\": \"$public_label\"}"
assert_scan changed_label 1 generic-api-key "{\"key_id\": \"${public_label%1}2\"}"
assert_scan suffixed_label 1 generic-api-key "{\"key_id\": \"${public_label}x\"}"
assert_scan different_field 1 generic-api-key "{\"api_key\": \"$public_label\"}"
assert_scan credential 1 github-pat "const deploymentCredential = \"$credential\";"
assert_scan same_field_credential 1 github-pat "{\"key_id\": \"$credential\"}"
assert_scan adjacent_credential 1 github-pat \
  "{\"key_id\": \"$public_label\", \"api_key\": \"$credential\"}"
if [[ "${passed[*]}" != 'public_label changed_label suffixed_label different_field credential same_field_credential adjacent_credential' ]]; then
  echo "[ci] SECRET_CANARY_INVENTORY_INVALID" >&2
  exit 1
fi
log "secret canaries: 7 passed (exact public label admitted; detector refusals retained)"
