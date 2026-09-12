import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, lookupInputs, monitorSources, observeHosted, staticPolicy, validateContext, validateMonitor } from "./source-policy.mjs";
import { selected } from "./source-custody-fixture.mjs";

const directory = mkdtempSync(join(tmpdir(), "bullet-source-policy-"));
const results = [];
const record = (name, value) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return file(path); };
const policy = JSON.parse(readFileSync("ops/ci/source-policy.json", "utf8"));
const policyReference = file(join(process.cwd(), "ops/ci/source-policy.json"));
const sources = monitorSources;
const sourceRoot = join(process.cwd(), "ops/proof/source-monitor");
const toolPath = (name) => name === "cargo" ? process.env.BULLET_CI_SOURCE_CARGO : name === "rustc" ? process.env.BULLET_CI_SOURCE_RUSTC : selected(name);
const names = ["bash", "node", "git", "timeout", "stat", "wc", "mkdir", "rm", "rmdir", "uname", "dirname", "sleep", "env", "cargo", "rustc"];
const tools = names.map((name) => ({ name, ...file(toolPath(name)), version_args: ["--version"],
  version_first_line: execFileSync(toolPath(name), ["--version"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).split(/\r?\n/)[0] }));
const executable = file(process.env.BULLET_CI_SOURCE_MONITOR_BIN);
const build = { schema: "bullet.source-monitor.build.v1", executable_sha256: executable.sha256, source_root: sourceRoot,
  sources: sources.map((name) => file(join(sourceRoot, name))), tools: ["cargo", "rustc"].map((name) => ({ name, ...file(toolPath(name)) })) };
const profile = { schema: "bullet.source-tool-profile.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", platform: "linux", inputs_complete: true, tools_complete: true,
  tools, input_roots: ["$CHECKOUT"], outputs: [{ path: ".ci-artifacts", reason: "explicit diagnostic fixture output" }],
  monitor: { executable_sha256: executable.sha256, sources: sources.map((name) => ({ name, sha256: file(join(sourceRoot, name)).sha256 })),
    tools: build.tools.map(({ name, sha256 }) => ({ name, sha256 })) } };
const profileReference = record("profile.json", profile);
const review = { schema: "bullet.source-policy-review.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", reviewer: "synthetic fixture reviewer", verdict: "accepted",
  policy_sha256: policyReference.sha256, tool_profile_sha256: profileReference.sha256,
  evaluator_sources: ["source-policy.mjs", "source-bootstrap.mjs", "source-custody.mjs"].map((name) => ({ name, sha256: file(join(process.cwd(), "ops/ci", name)).sha256 })) };
const reviewReference = record("review.json", review);
function case_(name, body) { try { body(); results.push({ name, status: "PASS" }); } catch (error) { results.push({ name, status: "FAIL", error: String(error.stack) }); throw error; } }
let success = false;
try {
  case_("lookup-profile-expands-only-explicit-checkout-paths", () => assert.deepEqual(
    lookupInputs([{ path: "$CHECKOUT/config-alias", kind: "file", target: "/admitted/config" },
      { path: "/admitted/absent", kind: "absent", target: null }], "/checkout"),
    [{ path: "/checkout/config-alias", kind: "file", target: "/admitted/config" },
      { path: "/admitted/absent", kind: "absent", target: null }]));
  for (const [name, declarations] of [
    ["non-array", null],
    ["relative", [{ path: "relative", kind: "absent", target: null }]],
    ["dotdot", [{ path: "/input/../other", kind: "absent", target: null }]],
    ["absent-with-target", [{ path: "/input", kind: "absent", target: "/target" }]],
    ["file-without-target", [{ path: "/input", kind: "file", target: null }]],
    ["extra-field", [{ path: "/input", kind: "absent", target: null, skip: true }]],
    ["duplicate", [0, 1].map(() => ({ path: "/input", kind: "absent", target: null }))],
  ]) case_(`lookup-${name}-refuses`, () => assert.throws(() => lookupInputs(declarations), /CI_SOURCE_POLICY/));
  case_("reviewed-policy-and-pinned-monitor-components-validate", () => { assert.equal(staticPolicy(policyReference, reviewReference, profileReference).policy.id, policy.id); validateMonitor(profile, executable, build); });
  case_("missing-independent-review-refuses", () => assert.throws(() => staticPolicy(policyReference, { path: reviewReference.path, sha256: "0".repeat(64) }, profileReference), /static input changed/));
  for (const field of ["policy_sha256", "tool_profile_sha256"]) case_(`review-${field}-drift-refuses`, () => {
    assert.throws(() => staticPolicy(policyReference, record(`${field}.json`, { ...review, [field]: "0".repeat(64) }), profileReference), /independent static policy review/);
  });
  case_("changed-evaluator-refuses-static-review-reuse", () => {
    const changed = structuredClone(review); changed.evaluator_sources[0].sha256 = "0".repeat(64);
    assert.throws(() => staticPolicy(policyReference, record("evaluator.json", changed), profileReference), /policy evaluator changed/);
  });
  case_("matching-substituted-monitor-and-build-still-refuse-reviewed-pin", () => {
    const substitute = file(selected("bash")); assert.throws(() => validateMonitor(profile, substitute, { ...build, executable_sha256: substitute.sha256 }), /not independently admitted/);
  });
  for (const kind of ["source", "tool"]) case_(`monitor-${kind}-binding-drift-refuses`, () => {
    const changed = structuredClone(build); changed[kind === "source" ? "sources" : "tools"][0].sha256 = "0".repeat(64);
    assert.throws(() => validateMonitor(profile, executable, changed), /differs from independent policy/);
  });
  const source = { commit_oid: "1".repeat(40), tree_oid: "2".repeat(40) };
  const observation = { schema: "bullet.source-hosted-observation.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", context: { GITHUB_REPOSITORY: policy.repositories[0], GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: source.commit_oid } };
  case_("unreviewed-pr-source-is-diagnostic-within-reviewed-policy", () => validateContext(policy, observation, source, "required"));
  for (const field of ["GITHUB_REPOSITORY", "GITHUB_EVENT_NAME", "GITHUB_SHA"]) case_(`wrong-${field}-refuses`, () => assert.throws(() => validateContext(policy, { ...observation, context: { ...observation.context, [field]: "outside-policy" } }, source, "required"), /outside reviewed policy/));
  case_("local-canonical-process-cannot-use-hosted-policy", () => {
    const before = process.env.RUNNER_ENVIRONMENT; delete process.env.RUNNER_ENVIRONMENT;
    try { assert.throws(() => observeHosted(process.cwd(), process.pid), /hosted Linux checkout/); }
    finally { if (before !== undefined) process.env.RUNNER_ENVIRONMENT = before; }
  });
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", GITHUB_WORKSPACE: process.cwd(), GITHUB_REPOSITORY: policy.repositories[0], GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", GITHUB_SHA: source.commit_oid, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "synthetic-policy-test" });
    case_("unreleased-same-user-process-refuses-even-with-hosted-env", () => assert.throws(() => observeHosted(process.cwd(), process.pid), /unreleased same-user process/));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); child.stdin.end(); assert.equal(await exited, 0);
  }
  success = true;
} finally {
  mkdirSync(".ci-artifacts/reports", { recursive: true });
  writeFileSync(".ci-artifacts/reports/source-policy-tests.json", JSON.stringify({ schema: "bullet.source-policy.tests.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", cases: results, policy_sha256: policyReference.sha256 }));
  if (success) { rmSync(directory, { recursive: true }); console.log(`[ci] source policy passed (${results.length} cases)`); }
  else console.error(`[ci] retained failed policy fixture ${directory}`);
}
