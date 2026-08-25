import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { validateNeeds } from "./aggregate.mjs";

const read = (path) => readFileSync(path, "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`CI_META_FAILED: ${message}`);
};
const lanes = ["fast", "lint", "contract", "security", "docs"];
const success = Object.fromEntries(
  lanes.map((lane) => [lane, { result: "success", outputs: { observation: "true" } }]),
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
assertThrows(() => validateNeeds(absentObservation), "aggregator accepted a missing observation");

const workflow = read(".github/workflows/ci.yml");
const scheduled = read(".github/workflows/scheduled.yml");
assert(workflow.includes("merge_group:"), "merge_group trigger absent");
assert(!workflow.includes("pull_request_target"), "pull_request_target is forbidden");
assert(!workflow.includes("ubuntu-latest"), "floating Ubuntu runner present");
assert(!/^\s*paths(?:-ignore)?:/m.test(workflow), "required workflow has a path filter");
assert(!workflow.includes("cache:"), "required workflow configures a cache");
assert(workflow.match(/persist-credentials: false/g)?.length === 6, "a required checkout may retain credentials");
assert(workflow.match(/node-version: "22\.23\.2"/g)?.length === 6, "Node pin drifted");
assert(workflow.match(/npm@10\.9\.8/g)?.length === 5, "npm pin drifted");
assert(/^name: CI$/m.test(workflow), "stable workflow name drifted");
assert(/^  required:\n    name: required$/m.test(workflow), "stable required job name drifted");
assert(!workflow.includes("name: CI / required"), "required job duplicates the workflow name");
assert(workflow.includes("if: ${{ always() }}"), "aggregator is not if: always()");
assert(
  workflow.includes("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"),
  "required aggregation does not download same-run artifacts through a pinned action",
);
assert(
  workflow.includes("portal-${{ github.run_id }}-${{ github.run_attempt }}-*"),
  "required artifact pattern is not bound to the exact run attempt",
);
assert(workflow.includes("EXPECTED_COMMIT: ${{ github.sha }}"), "required commit is not bound to github.sha");
assert(
  workflow.includes('node ops/ci/aggregate.mjs .ci-artifacts/atomic "$EXPECTED_COMMIT"'),
  "required workflow bypasses downloaded evidence validation",
);
assert(
  workflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"),
  "cancellation is not PR-only",
);
for (const lane of lanes) {
  assert(new RegExp(`^  ${lane}:$`, "m").test(workflow), `hosted ${lane} job absent`);
}
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
    assert(/^[^@]+@[0-9a-f]{40}$/.test(use), `action is not full-SHA pinned: ${use}`);
  }
}
assert(!/npm ci(?![^\n]*--ignore-scripts)/.test(workflow), "npm ci lacks --ignore-scripts");
assert(
  workflow.indexOf("preinstall-scan.mjs") < workflow.indexOf("npm install --global npm@10.9.8"),
  "source scan does not precede dependency installation",
);
assert(
  read("ops/ci/scheduled-hygiene.sh").includes("gitleaks git . --log-opts=--all"),
  "scheduled full-history scan absent",
);
assert(scheduled.includes("macos-15") && scheduled.includes("windows-2025"), "portable OS matrix drifted");
assert(scheduled.includes("scripts/ci-local.sh coverage"), "scheduled coverage absent");
assert(scheduled.includes("scripts/ci-local.sh portable"), "portable typed-refusal lane absent");
assert(!scheduled.includes("cache:"), "scheduled workflow configures a cache");
assertInstallOrdering(workflow, "required workflow");
assertInstallOrdering(scheduled, "scheduled workflow");

JSON.parse(read("agent/owner-map.json"));
JSON.parse(read("agent/test-map.json"));

const required = read("ops/ci/required.sh");
assert(required.includes("lanes=(fast lint contract security docs)"), "local required partition drift");
assert(!required.includes("real-farmd.sh"), "standalone required resolves real farmd");
const family = read("ops/ci/family.sh");
assert(family.includes("ops/ci/real-farmd.sh"), "family lane lost real-farmd proof");
assert(
  read("ops/ci/fast.sh").includes('assert-report.mjs vitest "$reports/vitest.json" 123'),
  "exact 123-test Vitest identity ratchet absent",
);
assert(
  read("ops/ci/fast.sh").includes("BULLET_FARMD_TEST_PROXY_INVALID"),
  "hostile farmd test-proxy refusal absent",
);
assert(
  read("ops/ci/contract.sh").includes('assert-report.mjs junit "$reports/playwright.xml" 10'),
  "exact 10-test mocked Playwright identity ratchet absent",
);
assert((read("ops/build/bundle-tests.ts").match(/^test\(/gm) ?? []).length === 5, "bundle test inventory drifted");
assert(
  ["e2e/control-tower.spec.ts", "e2e/fleet.spec.ts"]
    .map((path) => (read(path).match(/^test\(/gm) ?? []).length)
    .reduce((total, count) => total + count, 0) === 10,
  "standalone Playwright inventory drifted",
);
assert((read("e2e/real-farmd.spec.ts").match(/^\s*test\(/gm) ?? []).length === 3, "family test inventory drifted");
assert(read("ops/ci/security.sh").includes("secret-canary.sh"), "secret canary absent");
const ignoredFingerprints = read(".gitleaksignore").trim().split("\n").filter(Boolean);
assert(ignoredFingerprints.length === 1, "historical secret ignore is not exact-singleton");
const jeryu = read("ci.toml");
const jeryuAdapter = read("ops/ci/jeryu-lane.sh");
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
}
assert(jeryu.includes('id = "required"'), "ci.toml required convergence absent");
assert(!jeryu.includes('artifact_paths = [".ci-artifacts"]'), "ci.toml exports a broad artifact root");
assert(
  jeryu.includes(
    'run = ["bash ops/ci/jeryu-activation-gate.sh", "node ops/ci/aggregate.mjs --jeryu"]',
  ),
  "ci.toml required convergence is not activation-gated",
);
const directJeryu = spawnSync(process.execPath, ["ops/ci/aggregate.mjs", "--jeryu"], {
  encoding: "utf8",
});
assert(directJeryu.status !== 0, "unratified direct Jeryu convergence reported success");
assert(
  directJeryu.stderr.includes("JERYU_STATUS_BINDING_UNRATIFIED"),
  "direct Jeryu refusal lost its stable code",
);
const justfile = read("Justfile");
const setup = justfile.match(/^setup:\n((?:    .+\n)+)/m)?.[1] ?? "";
assert(setup.includes("preinstall-scan.mjs"), "local setup lost source admission");
assert(
  setup.indexOf("preinstall-scan.mjs") < setup.indexOf("npm ci --ignore-scripts"),
  "local setup installs before source admission",
);
assert(setup.includes("require_node_floor"), "local setup bypasses exact Node/npm admission");
assert(
  setup.indexOf("require_node_floor") < setup.indexOf("npm ci --ignore-scripts"),
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
    new RegExp(`\\[\\[lane\\]\\]\\nname = "${lane}"\\n([\\s\\S]*?)(?=\\n\\[\\[lane\\]\\]|$)`),
  )?.[1];
  assert(
    definition?.includes("requires_network = true"),
    `${lane} does not declare npm-audit network use`,
  );
}
console.log("[ci] CI meta-tests passed, including negative aggregator fixtures");

function assertThrows(callback, message) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(`CI_META_FAILED: ${message}`);
}

function assertInstallOrdering(definition, label) {
  const sections = definition.split(/(?=^  [a-z][a-z0-9_-]*:$)/m).slice(1);
  for (const section of sections) {
    const job = section.match(/^  ([a-z][a-z0-9_-]*):/)?.[1] ?? "unknown";
    const installers = [
      "npm install --global",
      "npm ci ",
      "bash ops/ci/install-gitleaks.sh",
      "taiki-e/install-action@",
      "playwright install",
    ]
      .map((needle) => section.indexOf(needle))
      .filter((index) => index >= 0);
    if (installers.length === 0) continue;
    const scan = section.indexOf("preinstall-scan.mjs");
    assert(scan >= 0 && scan < Math.min(...installers), `${label} ${job} installs before source scan`);
  }
}
