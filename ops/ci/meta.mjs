import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateNeeds } from "./aggregate.mjs";
import { validateHostedWorkflows } from "./hosted-workflow-policy.mjs";
import {
  NIGHTLY_PURPOSE,
  validateNightlyChain,
  validateNightlyProofLane,
} from "./meta-nightly.mjs";
import { ZIZMOR_COMMAND, validateZizmorClaim } from "./zizmor-policy.mjs";

const read = (path) => readFileSync(path, "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`CI_META_FAILED: ${message}`);
};
const lanes = ["fast", "lint", "contract", "security", "docs"];
const success = Object.fromEntries(
  lanes.map((lane) => [
    lane,
    { result: "success", outputs: { observation: "true" } },
  ]),
);
validateNeeds(success);
for (const result of ["failure", "skipped", "cancelled"]) {
  const fixture = structuredClone(success);
  fixture.fast.result = result;
  assertThrows(() => validateNeeds(fixture), `aggregator accepted ${result}`);
}
const missing = structuredClone(success);
delete missing.docs;
assertThrows(() => validateNeeds(missing), "aggregator accepted a missing job");
const absentObservation = structuredClone(success);
absentObservation.security.outputs = {};
assertThrows(
  () => validateNeeds(absentObservation),
  "aggregator accepted a missing observation",
);

const workflow = read(".github/workflows/ci.yml");
const scheduled = read(".github/workflows/scheduled.yml");
assert(workflow.includes("merge_group:"), "merge_group trigger absent");
assert(
  !workflow.includes("pull_request_target"),
  "pull_request_target is forbidden",
);
assert(!workflow.includes("ubuntu-latest"), "floating Ubuntu runner present");
assert(
  !/^\s*paths(?:-ignore)?:/m.test(workflow),
  "required workflow has a path filter",
);
assert(!workflow.includes("cache:"), "required workflow configures a cache");
assert(
  workflow.match(/persist-credentials: false/g)?.length === 6,
  "a required checkout may retain credentials",
);
assert(
  workflow.match(/node-version: "22\.23\.2"/g)?.length === 6,
  "Node pin drifted",
);
assert(workflow.match(/npm@10\.9\.8/g)?.length === 5, "npm pin drifted");
assert(/^name: CI$/m.test(workflow), "stable workflow name drifted");
assert(
  !workflow.includes("name: CI / required"),
  "required job duplicates the workflow name",
);
assert(
  workflow.includes(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  ),
  "cancellation is not PR-only",
);
let currentJob;
for (const line of workflow.split("\n")) {
  const job = line.match(/^  ([a-z][a-z0-9_-]*):$/)?.[1];
  if (job) currentJob = job;
  if (/^    needs:/.test(line) && lanes.includes(currentJob)) {
    throw new Error(`CI_META_FAILED: ${currentJob} is not parallel`);
  }
}
for (const definition of [workflow, scheduled]) {
  for (const match of definition.matchAll(/^\s*- uses:\s*([^\s#]+).*$/gm)) {
    const use = match[1];
    assert(
      /^[^@]+@[0-9a-f]{40}$/.test(use),
      `action is not full-SHA pinned: ${use}`,
    );
  }
}
assert(
  !/npm ci(?![^\n]*--ignore-scripts)/.test(workflow),
  "npm ci lacks --ignore-scripts",
);
validateHostedWorkflows(workflow, scheduled);
const sanitizerTest = spawnSync(
  process.execPath,
  ["ops/ci/sanitize-artifacts-test.mjs"],
  { encoding: "utf8" },
);
assert(
  sanitizerTest.status === 0,
  `staged-artifact hostiles failed: ${sanitizerTest.stderr}`,
);
const reportIdentityTest = spawnSync(
  process.execPath,
  ["ops/ci/assert-report-test.mjs"],
  { encoding: "utf8" },
);
assert(
  reportIdentityTest.status === 0,
  `Vitest identity hostiles failed: ${reportIdentityTest.stderr}`,
);
assert(
  read("ops/ci/scheduled-hygiene.sh").includes(
    "gitleaks git . --log-opts=--all",
  ),
  "scheduled full-history scan absent",
);
assert(
  scheduled.includes("macos-15") && scheduled.includes("windows-2025"),
  "portable OS matrix drifted",
);
assert(!scheduled.includes("cache:"), "scheduled workflow configures a cache");

JSON.parse(read("agent/owner-map.json"));
JSON.parse(read("agent/test-map.json"));

const required = read("ops/ci/required.sh");
assert(
  required.includes("lanes=(fast lint contract security docs)"),
  "local required partition drift",
);
assert(
  !required.includes("real-farmd.sh"),
  "standalone required resolves real farmd",
);
const family = read("ops/ci/family.sh");
assert(
  family.includes("ops/ci/real-farmd.sh"),
  "family lane lost real-farmd proof",
);
assert(
  read("ops/ci/fast.sh").includes(
    'assert-report.mjs vitest "$reports/vitest.json" 131',
  ),
  "exact 131-test Vitest count ratchet absent",
);
assert(
  read("ops/ci/fast.sh").includes(
    "f4805174c97eb600794e0105adfbbe0809392981cc2ad88cb1800fa711c525dd",
  ) && read("ops/ci/coverage.sh").includes(
    "f4805174c97eb600794e0105adfbbe0809392981cc2ad88cb1800fa711c525dd",
  ),
  "exact Vitest identity digest ratchet absent",
);
assert(
  read("ops/ci/fast.sh").includes("BULLET_FARMD_TEST_PROXY_INVALID"),
  "hostile farmd test-proxy refusal absent",
);
assert(
  read("ops/ci/contract.sh").includes(
    'assert-report.mjs junit "$reports/playwright.xml" 14',
  ),
  "exact 14-test mocked Playwright count ratchet absent",
);
assert(
  read("ops/ci/contract.sh").includes(
    "8a95898f88efe2d2f8c7a2f2883868041ec96cb60a20d31af6761300a94983ad",
  ),
  "exact mocked Playwright identity digest ratchet absent",
);
assert(
  (read("ops/build/bundle-tests.ts").match(/^test\(/gm) ?? []).length === 5,
  "bundle test inventory drifted",
);
assert(
  ["e2e/control-tower.spec.ts", "e2e/fleet.spec.ts", "e2e/shift-brief.spec.ts"]
    .map((path) => (read(path).match(/^test\(/gm) ?? []).length)
    .reduce((total, count) => total + count, 0) === 14,
  "standalone Playwright inventory drifted",
);
assert(
  (read("e2e/real-farmd.spec.ts").match(/^\s*test\(/gm) ?? []).length === 3,
  "family test inventory drifted",
);
const security = read("ops/ci/security.sh");
assert(security.includes("secret-canary.sh"), "secret canary absent");
const zizmorProse = [
  read("docs/release.md"),
  read("docs/testing.md"),
  read("tools/security-lane.sh"),
];
validateZizmorClaim(security, zizmorProse);
for (const hostileSecurity of [
  ...["--offline ", "--no-ignores ", "--strict-collection "].map((flag) =>
    security.replace(flag, ""),
  ),
  security.replace(ZIZMOR_COMMAND, "zizmor ."),
  security.replace(ZIZMOR_COMMAND, `${ZIZMOR_COMMAND}\n${ZIZMOR_COMMAND}`),
  security.replace(ZIZMOR_COMMAND, `${ZIZMOR_COMMAND} || true`),
  security.replace("set -euo pipefail", "set -uo pipefail"),
  security.replace(ZIZMOR_COMMAND, `set +e\n${ZIZMOR_COMMAND}`),
  security.replace(ZIZMOR_COMMAND, `set +o errexit\n${ZIZMOR_COMMAND}`),
  security.replace(
    ZIZMOR_COMMAND,
    `trap 'exit 0' EXIT\n${ZIZMOR_COMMAND}`,
  ),
  security.replace(ZIZMOR_COMMAND, `${ZIZMOR_COMMAND}\nexit 0`),
  security.replace(
    ZIZMOR_COMMAND,
    `${ZIZMOR_COMMAND}\nstatus=$?\nexit 0`,
  ),
  security.replace("require_tool zizmor || exit 1", "builtin set +e"),
  security.replace("require_tool zizmor || exit 1", "command set +e"),
  security.replace(
    'log "security lane"',
    'log "security lane"; set +e',
  ),
  security.replace(
    'log "security lane"',
    'log "security lane"; trap \'exit 0\' EXIT',
  ),
  security.replace(
    'log "security lane"',
    'log "security lane"; zizmor() { return 0; }',
  ),
  security.replace(
    'log "security lane"',
    'log "security lane"; shopt -s expand_aliases; alias zizmor=true',
  ),
]) {
  assertThrows(
    () => validateZizmorClaim(hostileSecurity, zizmorProse),
    "weakened zizmor invocation was accepted",
  );
}
const ignoredFingerprints = read(".gitleaksignore")
  .trim()
  .split("\n")
  .filter(Boolean);
assert(
  ignoredFingerprints.length === 1,
  "historical secret ignore is not exact-singleton",
);
const jeryu = read("ci.toml");
const jeryuAdapter = read("ops/ci/jeryu-lane.sh");
validatePreparedJeryu(jeryu, jeryuAdapter);
for (const hostileAdapter of [
  jeryuAdapter.replace(
    'bash scripts/ci-local.sh "$lane"',
    'true # bash scripts/ci-local.sh "$lane"',
  ),
  jeryuAdapter.replace(
    "bash scripts/ci-observation.sh \\",
    "true # bash scripts/ci-observation.sh \\",
  ),
  jeryuAdapter
    .replace("bash scripts/ci-observation.sh \\", "__OBSERVATION__")
    .replace(
      'node ops/ci/sanitize-artifacts.mjs "$lane"',
      "bash scripts/ci-observation.sh \\",
    )
    .replace("__OBSERVATION__", 'node ops/ci/sanitize-artifacts.mjs "$lane"'),
  jeryuAdapter.replace('exit "$status"', 'exit 0 # exit "$status"'),
]) {
  assertThrows(
    () => validatePreparedJeryu(jeryu, hostileAdapter),
    "prepared Jeryu adapter mutation was accepted",
  );
}
const noOpJeryu = jeryu.replace(
  'run = ["bash ops/ci/jeryu-activation-gate.sh", "bash ops/ci/jeryu-lane.sh fast"]',
  'run = ["bash ops/ci/jeryu-activation-gate.sh", "true"] # run = ["bash ops/ci/jeryu-activation-gate.sh", "bash ops/ci/jeryu-lane.sh fast"]',
);
const broadJeryu = jeryu.replace(
  'artifact_paths = [\n  ".ci-artifacts/observations/fast.json",\n  ".ci-artifacts/reports/vitest.json",\n  ".ci-artifacts/reports/vite-api-override.log",\n  ".ci-artifacts/reports/farmd-test-proxy-override.log",\n]',
  'artifact_paths = [".ci-artifacts/"] # .ci-artifacts/observations/fast.json',
);
for (const hostileConfig of [noOpJeryu, broadJeryu]) {
  assertThrows(
    () => validatePreparedJeryu(hostileConfig, jeryuAdapter),
    "prepared Jeryu configuration mutation was accepted",
  );
}
assert(
  jeryuAdapter.includes('bash scripts/ci-local.sh "$lane"') &&
    jeryuAdapter.includes("bash scripts/ci-observation.sh") &&
    jeryuAdapter.includes("node ops/ci/sanitize-artifacts.mjs"),
  "prepared Jeryu adapter bypasses a local lane, observation, or sanitization",
);
for (const lane of lanes) {
  assert(jeryu.includes(`id = "${lane}"`), `ci.toml lost ${lane}`);
  assert(
    jeryu.includes(
      `run = ["bash ops/ci/jeryu-activation-gate.sh", "bash ops/ci/jeryu-lane.sh ${lane}"]`,
    ),
    `ci.toml bypasses the gated local ${lane} adapter`,
  );
  assert(
    jeryu.includes(`.ci-artifacts/observations/${lane}.json`),
    `ci.toml does not export the ${lane} observation`,
  );
  assert(
    jeryuAdapter.includes(`node ops/ci/sanitize-artifacts.mjs "$lane"`),
    "prepared Jeryu adapter does not pass the admitted lane to staging",
  );
}
assert(
  jeryu.includes('id = "required"'),
  "ci.toml required convergence absent",
);
assert(
  !jeryu.includes('artifact_paths = [".ci-artifacts"]'),
  "ci.toml exports a broad artifact root",
);
assert(
  jeryu.includes(
    'run = ["bash ops/ci/jeryu-activation-gate.sh", "node ops/ci/aggregate.mjs --jeryu"]',
  ),
  "ci.toml required convergence is not activation-gated",
);
const directJeryu = spawnSync(
  process.execPath,
  ["ops/ci/aggregate.mjs", "--jeryu"],
  {
    encoding: "utf8",
  },
);
assert(
  directJeryu.status !== 0,
  "unratified direct Jeryu convergence reported success",
);
assert(
  directJeryu.stderr.includes("JERYU_STATUS_BINDING_UNRATIFIED"),
  "direct Jeryu refusal lost its stable code",
);
const justfile = read("Justfile");
const ciLocal = read("scripts/ci-local.sh");
const nightly = read("ops/ci/nightly.sh");
validateNightlyChain(justfile, ciLocal, nightly);
const nightlyCall = "bash ops/ci/family.sh";
const nightlyRoute = "nightly)  bash ops/ci/nightly.sh ;;";
for (const [hostileJustfile, hostileCiLocal, hostileNightly] of [
  [justfile, ciLocal, nightly.replace(nightlyCall, "true")],
  [justfile, ciLocal, nightly.replace(nightlyCall, `# ${nightlyCall}`)],
  [
    justfile,
    ciLocal,
    nightly.replace(nightlyCall, `${nightlyCall}\n${nightlyCall}`),
  ],
  [
    justfile.replace(
      "bash scripts/ci-local.sh nightly",
      "bash scripts/ci-local.sh family",
    ),
    ciLocal,
    nightly,
  ],
  [
    justfile,
    ciLocal.replace(nightlyRoute, "nightly)  bash ops/ci/family.sh ;;"),
    nightly,
  ],
  [justfile, ciLocal, nightly.replace(nightlyCall, `${nightlyCall} || true`)],
  [justfile, ciLocal, nightly.replace(nightlyCall, `${nightlyCall} &`)],
  [
    justfile,
    ciLocal,
    nightly.replace(nightlyCall, `set +e\n${nightlyCall}\nexit 0`),
  ],
]) {
  assertThrows(
    () => validateNightlyChain(hostileJustfile, hostileCiLocal, hostileNightly),
    "nightly compatibility-chain mutation was accepted",
  );
}
const setup = justfile.match(/^setup:\n((?:    .+\n)+)/m)?.[1] ?? "";
assert(
  setup.includes("preinstall-scan.mjs"),
  "local setup lost source admission",
);
assert(
  setup.indexOf("preinstall-scan.mjs") <
    setup.indexOf("npm ci --ignore-scripts"),
  "local setup installs before source admission",
);
assert(
  setup.includes("require_node_floor"),
  "local setup bypasses exact Node/npm admission",
);
assert(
  setup.indexOf("require_node_floor") <
    setup.indexOf("npm ci --ignore-scripts"),
  "local setup checks Node/npm only after installation",
);
const toolchain = read("ops/ci/lib.sh");
assert(
  toolchain.includes('"v22.23.2"') && toolchain.includes('"10.9.8"'),
  "local exact Node/npm identity drifted",
);
assert(
  read("scripts/ci-doctor.sh").includes("require_node_floor"),
  "ci-doctor bypasses the exact Node/npm check",
);
assert(
  read("ops/ci/docs.sh").includes("bash ops/ci/toolchain-test.sh"),
  "wrong-version hostile proof is not load-bearing",
);
const proofLanes = read("agent/proof-lanes.toml");
for (const lane of ["security", "required"]) {
  const definition = proofLanes.match(
    new RegExp(
      `\\[\\[lane\\]\\]\\nname = "${lane}"\\n([\\s\\S]*?)(?=\\n\\[\\[lane\\]\\]|$)`,
    ),
  )?.[1];
  assert(
    definition?.includes("requires_network = true"),
    `${lane} does not declare npm-audit network use`,
  );
}
validateNightlyProofLane(proofLanes);
assertThrows(
  () =>
    validateNightlyProofLane(
      proofLanes.replace(
        `purpose = "${NIGHTLY_PURPOSE}"`,
        'purpose = "explicit live-oracle entrypoint"',
      ),
    ),
  "nightly metadata accepted a fabricated live-oracle claim",
);
assertThrows(
  () =>
    validateNightlyProofLane(
      proofLanes.replace(
        'name = "nightly"\ncommand = "just nightly"',
        'name = "nightly"\ncommand = "just family"',
      ),
    ),
  "nightly metadata accepted a command that bypasses its alias entrypoint",
);
console.log(
  "[ci] CI meta-tests passed, including negative aggregator fixtures",
);

function assertThrows(callback, message) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(`CI_META_FAILED: ${message}`);
}

function validatePreparedJeryu(configuration, adapter) {
  assert(
    createHash("sha256").update(configuration).digest("hex") ===
      "2d0ff5769c25b76242d9e6e451f6295f2b6560bccc3896998864d220d51d3342",
    "prepared Jeryu configuration source drifted",
  );
  assert(
    createHash("sha256").update(adapter).digest("hex") ===
      "8bd8c8d471b73bba976501909efe8a226ecb51a3f82fdc1ef072fb96225273c9",
    "prepared Jeryu adapter source drifted",
  );
}
