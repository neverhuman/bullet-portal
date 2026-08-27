import { semanticShellLines } from "./zizmor-policy.mjs";

export const NIGHTLY_PURPOSE =
  "compatibility alias for the exact family lane; invokes no provider, forge, or live oracle and preserves the family lane's outcome";

function assert(condition, message) {
  if (!condition) throw new Error(`CI_META_FAILED: ${message}`);
}

export function validateNightlyChain(justfile, ciLocal, nightly) {
  assert(
    (justfile.match(/^nightly:$/gm) ?? []).length === 1,
    "nightly Justfile recipe is missing or duplicated",
  );
  const recipe = justfile.match(/^nightly:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? "";
  assert(
    JSON.stringify(semanticShellLines(recipe)) ===
      JSON.stringify(["bash scripts/ci-local.sh nightly"]),
    "nightly Justfile recipe does not exclusively invoke ci-local nightly",
  );
  const routes = ciLocal.match(/^\s*nightly\).*$/gm) ?? [];
  assert(
    routes.length === 1 && routes[0].trim() === "nightly)  bash ops/ci/nightly.sh ;;",
    "ci-local nightly route is missing, duplicated, or bypasses nightly.sh",
  );
  assert(
    JSON.stringify(semanticShellLines(nightly)) ===
      JSON.stringify([
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
        'cd "$REPO_ROOT"',
        'log "nightly lane"',
        "bash ops/ci/family.sh",
        'log "nightly lane passed"',
      ]),
    "nightly.sh is not the exact foreground fail-closed family alias",
  );
}

export function validateNightlyProofLane(definition) {
  const matches = [
    ...definition.matchAll(
      /\[\[lane\]\]\nname = "nightly"\n([\s\S]*?)(?=\n\[\[lane\]\]|$)/g,
    ),
  ];
  assert(matches.length === 1, "nightly proof-lane block is missing or duplicated");
  const body = matches[0][1];
  assert(
    body.includes('command = "just nightly"\n'),
    "nightly proof lane does not invoke its compatibility alias",
  );
  assert(
    body.includes(`purpose = "${NIGHTLY_PURPOSE}"\n`),
    "nightly proof lane claims a subject other than the family compatibility alias",
  );
  assert(
    body.includes("requires_network = false\n"),
    "nightly proof lane network declaration drifted from its family alias",
  );
}
