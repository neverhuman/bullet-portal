#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' \
  '{"code":"JERYU_CI_ACTIVATION_BLOCKED","status":"REFUSED","reason":"runner profile, immutable subject provisioning, and required-context read-back are not ratified"}' >&2
exit 78
