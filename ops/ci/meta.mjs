import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const aggregateCli = (fixture) =>
  spawnSync(process.execPath, ["ops/ci/aggregate.mjs"], {
    env: { ...process.env, NEEDS_JSON: JSON.stringify(fixture) },
    encoding: "utf8",
  });
assert(aggregateCli(success).status === 0, "aggregator CLI rejected the all-success fixture");
for (const result of ["failure", "skipped", "cancelled"]) {
  const fixture = structuredClone(success);
  fixture.fast.result = result;
  assertThrows(() => validateNeeds(fixture), `aggregator accepted ${result}`);
}
const missing = structuredClone(success);
delete missing.docs;
assertThrows(() => validateNeeds(missing), "aggregator accepted a missing job");
assert(aggregateCli(missing).status !== 0, "aggregator CLI accepted a missing job");
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
assert(workflow.includes("name: CI / required"), "stable required context absent");
assert(workflow.includes("if: ${{ always() }}"), "aggregator is not if: always()");
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
assert(read("ops/ci/fast.sh").includes("assert-report.mjs vitest"), "fast zero-test guard absent");
assert(read("ops/ci/contract.sh").includes("assert-report.mjs junit"), "contract zero-test guard absent");
assert((read("ops/build/bundle-tests.ts").match(/^test\(/gm) ?? []).length === 5, "bundle test inventory drifted");
assert(
  ["e2e/control-tower.spec.ts", "e2e/fleet.spec.ts"]
    .map((path) => (read(path).match(/^test\(/gm) ?? []).length)
    .reduce((total, count) => total + count, 0) === 10,
  "standalone Playwright inventory drifted",
);
assert((read("e2e/real-farmd.spec.ts").match(/^\s*test\(/gm) ?? []).length === 2, "family test inventory drifted");
assert(read("ops/ci/security.sh").includes("secret-canary.sh"), "secret canary absent");
const ignoredFingerprints = read(".gitleaksignore").trim().split("\n").filter(Boolean);
assert(ignoredFingerprints.length === 1, "historical secret ignore is not exact-singleton");
const jeryu = read("ci.toml");
for (const lane of lanes) {
  assert(jeryu.includes(`id = "${lane}"`), `ci.toml lost ${lane}`);
  assert(jeryu.includes(`bash scripts/ci-local.sh ${lane}`), `ci.toml bypasses local ${lane} lane`);
}
assert(jeryu.includes('id = "required"'), "ci.toml required convergence absent");
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
