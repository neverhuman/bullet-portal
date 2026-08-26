export const ZIZMOR_COMMAND =
  "zizmor --offline --no-ignores --strict-collection .";

const EXPECTED_SECURITY_SEMANTICS = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
  'cd "$REPO_ROOT"',
  "require_node_floor",
  'log "security lane"',
  "require_tool gitleaks || exit 1",
  "require_tool zizmor || exit 1",
  '[[ "$(gitleaks version)" == "8.21.2" ]] || {',
  'echo "[ci] gitleaks 8.21.2 required" >&2',
  "exit 1",
  "}",
  '[[ "$(zizmor --version)" == "zizmor 1.25.2" ]] || {',
  'echo "[ci] zizmor 1.25.2 required" >&2',
  "exit 1",
  "}",
  '[[ -f package-lock.json ]] || { echo "[ci] package-lock.json missing" >&2; exit 1; }',
  "gitleaks detect --source . --no-git --redact --no-banner",
  "grep -Fq 'const CSRF_STORAGE_SLOT' src/api.ts || {",
  'echo "[ci] expected non-secret CSRF storage symbol is absent" >&2',
  "exit 1",
  "}",
  "if grep -Fq 'CSRF_STORAGE_KEY' src/api.ts; then",
  'echo "[ci] secret-like CSRF storage identifier regressed" >&2',
  "exit 1",
  "fi",
  "bash ops/ci/secret-canary.sh",
  "npm audit",
  ZIZMOR_COMMAND,
  'log "security lane passed"',
];

const assertPolicy = (condition, message) => {
  if (!condition) throw new Error(`CI_META_FAILED: ${message}`);
};

export function validateZizmorClaim(security, [release, testing, wrapper]) {
  const lines = semanticShellLines(security);
  const invocations = lines.filter((line) => line === ZIZMOR_COMMAND);

  assertPolicy(
    JSON.stringify(lines) === JSON.stringify(EXPECTED_SECURITY_SEMANTICS),
    "security lane ordered semantic inventory drifted",
  );
  assertPolicy(
    lines[0] === "#!/usr/bin/env bash" && lines[1] === "set -euo pipefail",
    "security lane lost its strict errexit preamble",
  );
  assertPolicy(
    lines.filter((line) => line === "set -euo pipefail").length === 1 &&
      !lines.slice(2).some((line) => line.startsWith("set ")),
    "security lane changes shell options after strict admission",
  );
  assertPolicy(
    !lines.some((line) => /^(?:trap|eval|alias|function)\b/.test(line)),
    "security lane installs a failure-masking shell control",
  );
  assertPolicy(
    invocations.length === 1,
    "security lane lost the exact singleton strict-offline zizmor invocation",
  );
  assertPolicy(
    JSON.stringify(lines.slice(-4)) ===
      JSON.stringify([
        "bash ops/ci/secret-canary.sh",
        "npm audit",
        ZIZMOR_COMMAND,
        'log "security lane passed"',
      ]),
    "security lane does not propagate the foreground zizmor status",
  );

  const literal = `\`${ZIZMOR_COMMAND}\``;
  for (const [name, prose] of [["release", release], ["testing", testing]]) {
    assertPolicy(
      prose.split(literal).length === 2,
      `${name} docs lost the exact singleton strict-offline zizmor literal`,
    );
  }
  assertPolicy(
    wrapper.split("\n").filter((line) => line === `#   ${ZIZMOR_COMMAND}`)
      .length === 1,
    "security wrapper lost the exact singleton strict-offline zizmor literal",
  );
}

export function semanticShellLines(definition) {
  return definition
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && (!line.startsWith("#") || line.startsWith("#!")));
}
