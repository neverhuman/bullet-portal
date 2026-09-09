import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve("ops/ci/sanitize-artifacts.mjs");
const run = (root) =>
  spawnSync(process.execPath, [script, "fast"], {
    cwd: root,
    encoding: "utf8",
  });
let root = makeFixture();
try {
  const result = run(root);
  assert(result.status === 0, `exact staged fixture failed: ${result.stderr}`);
  for (const path of [
    "observations/fast.json",
    "reports/farmd-test-proxy-override.log",
    "reports/vite-api-override.log",
    "reports/vitest.json",
  ]) {
    assert(
      existsSync(join(root, "target/ci-upload/fast", path)),
      `staged file missing: ${path}`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

refusal("unlisted artifact", (fixture, observation) => {
  const path = join(fixture, ".ci-artifacts/raw.log");
  writeFileSync(path, "raw\n");
  observation.artifact_hashes.push({
    path: ".ci-artifacts/raw.log",
    sha256: hash(path),
  });
});
refusal("duplicate artifact", (_fixture, observation) => {
  observation.artifact_hashes.push({...observation.artifact_hashes[0]});
});
refusal("hash mismatch", (_fixture, observation) => {
  observation.artifact_hashes[0].sha256 = "0".repeat(64);
});
refusal("symlinked report", (fixture) => {
  const path = join(fixture, ".ci-artifacts/reports/vitest.json");
  rmSync(path);
  symlinkSync("vite-api-override.log", path);
});
refusal("secret-shaped report", (fixture, observation) => {
  const path = join(fixture, ".ci-artifacts/reports/vitest.json");
  writeFileSync(path, "gh" + "p_" + "A".repeat(36));
  observation.artifact_hashes.find((entry) =>
    entry.path.endsWith("vitest.json"),
  ).sha256 = hash(path);
});
console.log(
  "[ci] staged-artifact allowlist, hash, symlink, and redaction hostiles passed",
);

function refusal(label, mutate) {
  const fixture = makeFixture();
  try {
    const observationPath = join(
      fixture,
      ".ci-artifacts/observations/fast.json",
    );
    const observation = JSON.parse(readFileSync(observationPath, "utf8"));
    mutate(fixture, observation);
    writeFileSync(observationPath, JSON.stringify(observation) + "\n");
    assert(run(fixture).status !== 0, `sanitizer accepted ${label}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function makeFixture() {
  const fixture = mkdtempSync(join(tmpdir(), "bullet-portal-stage-"));
  const bodies = {
    ".ci-artifacts/reports/farmd-test-proxy-override.log": "typed refusal\n",
    ".ci-artifacts/reports/vite-api-override.log": "typed refusal\n",
    ".ci-artifacts/reports/vitest.json": '{"numTotalTests":131}\n',
  };
  for (const [relative, body] of Object.entries(bodies)) {
    const path = join(fixture, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const observation = {
    repository: "bullet-portal",
    outcomes: [{ lane: "fast", status: "PASS", exit_code: 0 }],
    artifact_hashes: Object.keys(bodies).map((relative) => ({
      path: relative,
      sha256: hash(join(fixture, relative)),
    })),
  };
  const path = join(fixture, ".ci-artifacts/observations/fast.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(observation) + "\n");
  return fixture;
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(`CI_STAGE_TEST_FAILED: ${message}`);
}


const producer = resolve("ops/ci/observation.mjs");
const outputPolicy = {
  fast: ["reports/farmd-test-proxy-override.log", "reports/vite-api-override.log", "reports/vitest.json"],
  lint: [], contract: ["playwright/.last-run.json", "reports/playwright.xml"], security: [], docs: [],
  "scheduled-hygiene": [], coverage: ["coverage/coverage-summary.json", "reports/coverage-tests.json"],
  portable: ["platform/refusal.json", "reports/farmd-test-proxy-override.log", "reports/vite-api-override.log", "reports/vitest.json"],
};
let lifecycleCount = 0;
const execute = (fixture, command, args, env = {}) => spawnSync(command, args, { cwd: fixture, encoding: "utf8", env: { ...process.env, ...env } });
const observe = (fixture, ...args) => execute(fixture, process.execPath, [producer, ...args]);
const wrapper = (fixture, lane, env = {}) => execute(fixture, "bash", ["scripts/ci-local.sh", lane], env);
const sanitize = (fixture, lane) => execute(fixture, process.execPath, [script, lane]);
const reportPath = (fixture, lane) => join(fixture, `.ci-artifacts/observations/${lane}.json`);
const statePath = (fixture, lane) => join(fixture, `.ci-artifacts/lifecycle/active/${lane}.json`);
const generation = (fixture, lane) => JSON.parse(readFileSync(statePath(fixture, lane))).generation;
const history = (fixture, id) => join(fixture, `.ci-artifacts/lifecycle/generations/${id}`);
function good(result, label) { assert(result.status === 0, `${label}: ${result.stderr}`); return result.stdout.trim(); }
function bad(result, label) { assert(result.status !== 0, `accepted ${label}`); }
function put(fixture, path, body = "same bytes\n") {
  const destination = join(fixture, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, body);
}
function outputs(fixture, lane) { for (const path of outputPolicy[lane]) put(fixture, `.ci-artifacts/${path}`); }
function owner(fixture) {
  const value = `schema=2 repository=bullet-portal scope=family pid=${process.pid} lane=family nonce=1-2-3-4`;
  mkdirSync(join(fixture, ".git/bullet-ci.lock.d"), { mode: 0o700 });
  put(fixture, ".git/bullet-ci.lock.d/owner", value + "\n");
  chmodSync(join(fixture, ".git/bullet-ci.lock.d/owner"), 0o600);
  return value;
}
function operation(fixture, custody, ...args) {
  return execute(fixture, process.execPath, [producer, ...args], { BULLET_CI_OBSERVATION_OWNER: custody });
}
function lifecycle(label, check) {
  const fixture = mkdtempSync(join(tmpdir(), "bullet-portal-lifecycle-"));
  try {
    for (const path of ["scripts/ci-local.sh", "scripts/ci-observation.sh", "ops/ci/observation.mjs", "ops/ci/required.sh", "ops/ci/lib.sh"]) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      copyFileSync(resolve(path), join(fixture, path));
    }
    put(fixture, ".gitignore", ".ci-artifacts/\ntarget/\n");
    put(fixture, "subject.txt", "source\n");
    put(fixture, "fixture.mjs", `import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {dirname} from 'node:path';
const lane=process.argv[2];
if(process.env.BULLET_CI_PROOF_CUSTODY || process.env.BULLET_CI_OBSERVATION_OWNER) process.exit(91);
mkdirSync('.ci-artifacts',{recursive:true});appendFileSync('.ci-artifacts/dispatch.log',lane+'\\n');
if(process.env.NESTED==='1') {
 const {spawnSync}=await import('node:child_process');
 const nested=spawnSync('bash',['scripts/ci-local.sh','fast'],{encoding:'utf8'});
 if(nested.status!==75) process.exit(92);
}
const policy=${JSON.stringify(outputPolicy)};
if(process.env.NO_OUTPUT!=='1') for(const path of policy[lane]??[]){
 if(process.env.PARTIAL==='1' && !path.endsWith('vitest.json')) continue;
 mkdirSync(dirname('.ci-artifacts/'+path),{recursive:true});writeFileSync('.ci-artifacts/'+path,'same bytes\\n');
}
if(process.env.CHANGE_SOURCE==='1') writeFileSync('subject.txt','changed');
process.exit(process.env.FAIL_LANE===lane?19:0);`);
    for (const lane of [...Object.keys(outputPolicy), "family", "nightly", "audit", "packaged-farmd"]) {
      put(fixture, `ops/ci/${lane}.sh`, `#!/usr/bin/env bash\nset -euo pipefail\n'${process.execPath}' fixture.mjs ${lane}\n`);
    }
    good(execute(fixture, "git", ["init", "--quiet"]), "fixture Git init");
    good(execute(fixture, "git", ["add", "."]), "fixture add");
    good(execute(fixture, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]), "fixture commit");
    check(fixture);
    lifecycleCount++;
    console.log(`[ci] lifecycle pair passed: ${label}`);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}

lifecycle("every consumer lane inventory and unchanged legacy verification", (fixture) => {
  put(fixture, ".ci-artifacts/component/retained.log", "unrelated diagnostic");
  const retained = hash(join(fixture, ".ci-artifacts/component/retained.log"));
  for (const lane of Object.keys(outputPolicy)) {
    good(wrapper(fixture, lane), lane);
    const before = hash(reportPath(fixture, lane));
    good(observe(fixture, lane, "success", "0"), "legacy verify");
    good(observe(fixture, lane, "success", "0"), "idempotent verify");
    assert(hash(reportPath(fixture, lane)) === before, "legacy rebinding");
    good(sanitize(fixture, lane), "consumer inventory " + lane);
    const staged = join(fixture, `target/ci-upload/${lane}`);
    assert(!existsSync(join(staged, "lifecycle")), "generation state uploaded");
  }
  assert(hash(join(fixture, ".ci-artifacts/component/retained.log")) === retained, "unrelated diagnostic changed");
});
lifecycle("stale exact reports plus no-op success refuse", (fixture) => {
  outputs(fixture, "fast");
  bad(wrapper(fixture, "fast", { NO_OUTPUT: "1" }), "no-op stale outputs");
  bad(observe(fixture, "fast", "success", "0"), "incomplete invocation");
  assert(!existsSync(reportPath(fixture, "fast")), "stale PASS published");
});
lifecycle("identical bytes and Hub pre-deletion create new retained generations", (fixture) => {
  good(wrapper(fixture, "fast"), "first fast");
  const first = generation(fixture, "fast");
  const payload = join(history(fixture, first), "payload/.ci-artifacts/reports/vitest.json");
  const digest = hash(payload);
  rmSync(join(fixture, ".ci-artifacts/reports/vitest.json"));
  good(wrapper(fixture, "fast"), "identical fresh fast");
  assert(generation(fixture, "fast") !== first && hash(payload) === digest, "fresh generation/payload custody");
});
lifecycle("overlapping fast and portable retire prior observations", (fixture) => {
  for (const [before, after] of [["fast", "portable"], ["portable", "fast"]]) {
    good(wrapper(fixture, before), "overlap predecessor");
    const previous = generation(fixture, before);
    good(wrapper(fixture, after), "overlap successor");
    bad(observe(fixture, before, "success", "0"), "retired observation");
    good(sanitize(fixture, after), "selected overlap consumer");
    assert(existsSync(join(history(fixture, previous), "completion.json")), "retired completion lost");
  }
});
lifecycle("legacy missing references retain explicit disposition", (fixture) => {
  outputs(fixture, "fast");
  const refs = outputPolicy.fast.map((path) => ({path: `.ci-artifacts/${path}`, sha256: hash(join(fixture, `.ci-artifacts/${path}`))}));
  put(fixture, ".ci-artifacts/observations/fast.json", JSON.stringify({artifact_hashes:refs}));
  rmSync(join(fixture, ".ci-artifacts/reports/vitest.json"));
  good(wrapper(fixture, "fast"), "legacy adoption");
  const prepared = readFileSync(join(history(fixture, generation(fixture, "fast")), "prepared.json"), "utf8");
  assert(prepared.includes("MISSING_LEGACY_REFERENCE"), "missing legacy evidence invented");
});
lifecycle("corrupt complete payload refuses replacement", (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  put(fixture, `.ci-artifacts/lifecycle/generations/${generation(fixture, "fast")}/payload/.ci-artifacts/reports/vitest.json`, "corrupt");
  bad(wrapper(fixture, "fast"), "corrupt historical payload");
  bad(observe(fixture, "fast", "success", "0"), "corrupt legacy verification");
});
for (const mutation of ["replace", "delete"]) lifecycle(`sealed output ${mutation} rejects emitter and sanitizer`, (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  const before = hash(reportPath(fixture, "fast"));
  const path = join(fixture, ".ci-artifacts/reports/vitest.json");
  if (mutation === "replace") writeFileSync(path, "replacement"); else rmSync(path);
  bad(observe(fixture, "fast", "success", "0"), mutation);
  bad(sanitize(fixture, "fast"), mutation + " sanitizer");
  assert(hash(reportPath(fixture, "fast")) === before, "failed emitter rewrote hashes");
});
lifecycle("missing preparation and argument drift cannot set hosted present", (fixture) => {
  const env = { GITHUB_OUTPUT: join(fixture, ".ci-artifacts/present") };
  outputs(fixture, "fast");
  bad(execute(fixture, "bash", ["scripts/ci-observation.sh", "fast", "success", "0"], env), "missing prepare");
  assert(!existsSync(env.GITHUB_OUTPUT), "missing invocation present=true");
  good(wrapper(fixture, "fast"), "fresh wrapper");
  bad(observe(fixture, "fast", "success", "0", "true"), "command drift");
  bad(observe(fixture, "fast", "failure", "19"), "outcome drift");
  bad(observe(fixture, "fast", "cancelled", "130"), "cancelled drift");
  good(execute(fixture, "bash", ["scripts/ci-observation.sh", "fast", "success", "0", "bash scripts/ci-local.sh fast"], env), "hosted/Jeryu legacy shape");
  assert(readFileSync(env.GITHUB_OUTPUT, "utf8") === "present=true\n", "present output");
});
for (const phase of ["pending", "prepared", "completion"]) lifecycle(`interrupted ${phase} cannot restore old PASS`, (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  const custody = owner(fixture);
  const id = good(operation(fixture, custody, "prepare", "fast"), "new prepare");
  if (phase === "pending") rmSync(join(history(fixture, id), "prepared.json"));
  if (phase === "completion") {
    outputs(fixture, "fast");
    good(operation(fixture, custody, "seal", "fast", id, "success", "0"), "seal before interruption");
    rmSync(join(history(fixture, id), "completion.json"));
  }
  bad(observe(fixture, "fast", "success", "0"), "interrupted " + phase);
  bad(operation(fixture, custody, "prepare", "fast"), "unfinished replacement");
});
lifecycle("source and generation identity drift refuse seal", (fixture) => {
  const custody = owner(fixture);
  const id = good(operation(fixture, custody, "prepare", "fast"), "prepare");
  outputs(fixture, "fast");
  bad(operation(fixture, custody, "seal", "fast", "00000000-0000-4000-8000-000000000000", "success", "0"), "wrong generation");
  put(fixture, "subject.txt", "changed");
  bad(operation(fixture, custody, "seal", "fast", id, "success", "0"), "changed source");
});
for (const target of [".ci-artifacts", ".ci-artifacts/reports", ".ci-artifacts/reports/vitest.json"]) lifecycle(`symlink boundary ${target}`, (fixture) => {
  put(fixture, "target/outside/file", "sentinel");
  const outside = join(fixture, "target/outside");
  mkdirSync(dirname(join(fixture, target)), {recursive:true});
  symlinkSync(target.endsWith(".json") ? join(outside, "file") : outside, join(fixture, target));
  bad(wrapper(fixture, "fast"), "symlink prepare");
  assert(readFileSync(join(outside, "file"), "utf8") === "sentinel", "outside bytes changed");
});
lifecycle("failed child preserves partial FAIL and original status", (fixture) => {
  const result = wrapper(fixture, "fast", { FAIL_LANE: "fast", PARTIAL: "1" });
  assert(result.status === 19, "child failure lost");
  good(observe(fixture, "fast", "failure", "19"), "failure verification");
  good(sanitize(fixture, "fast"), "partial failure sanitization");
  assert(JSON.parse(readFileSync(reportPath(fixture, "fast"))).artifact_hashes.length === 1, "partial inventory");
});
lifecycle("failed seal cannot hide child failure", (fixture) => {
  const result = wrapper(fixture, "fast", { FAIL_LANE: "fast", CHANGE_SOURCE: "1" });
  assert(result.status === 19, "seal failure replaced child status");
  bad(observe(fixture, "fast", "success", "0"), "failed seal green");
});
lifecycle("inherited required custody, exact order, disjoint artifacts and real aggregate", (fixture) => {
  const custody = owner(fixture);
  good(wrapper(fixture, "required", { BULLET_CI_PROOF_CUSTODY: custody }), "inherited required");
  assert(readFileSync(join(fixture, ".git/bullet-ci.lock.d/owner"), "utf8") === custody + "\n", "family owner mutated/released");
  assert(readFileSync(join(fixture, ".ci-artifacts/dispatch.log"), "utf8") === "fast\nlint\ncontract\nsecurity\ndocs\n", "child order/count");
  const needs = {};
  for (const lane of ["fast", "lint", "contract", "security", "docs"]) {
    good(observe(fixture, lane, "success", "0"), "required post-wrapper");
    good(sanitize(fixture, lane), "required sanitizer");
    cpSync(join(fixture, `target/ci-upload/${lane}`), join(fixture, "target/download"), {recursive:true});
    needs[lane] = {result:"success", outputs:{observation:"true"}};
  }
  put(fixture, ".ci-artifacts/component/result.json", "later component result");
  const commit = good(execute(fixture, "git", ["rev-parse", "HEAD"]), "commit");
  good(execute(fixture, process.execPath, [resolve("ops/ci/aggregate.mjs"), "target/download", commit], {NEEDS_JSON:JSON.stringify(needs)}), "actual aggregate");
  const downloaded = join(fixture, "target/download/observations/fast.json");
  const report = JSON.parse(readFileSync(downloaded)); report.generation = "extra";
  writeFileSync(downloaded, JSON.stringify(report));
  bad(execute(fixture, process.execPath, [resolve("ops/ci/aggregate.mjs"), "target/download", commit], {NEEDS_JSON:JSON.stringify(needs)}), "extra wire metadata");
});
lifecycle("required stops at first failed child", (fixture) => {
  assert(wrapper(fixture, "required", {FAIL_LANE:"lint"}).status === 19, "required failure status");
  assert(readFileSync(join(fixture, ".ci-artifacts/dispatch.log"), "utf8") === "fast\nlint\n", "required continued after failure");
});
lifecycle("retained diagnostics remain in broad secret scan", (fixture) => {
  outputs(fixture, "fast");
  put(fixture, ".ci-artifacts/reports/vitest.json", "gh" + "p_" + "A".repeat(36));
  good(wrapper(fixture, "fast"), "fresh generation over secret diagnostic");
  bad(sanitize(fixture, "fast"), "retained secret");
});
lifecycle("unsupported evidence leaves preserve execution and refuse emitter", (fixture) => {
  for (const lane of ["family", "nightly", "audit", "packaged-farmd"]) {
    good(wrapper(fixture, lane), "unsupported evidence dispatch");
    bad(observe(fixture, lane, "success", "0"), "unsupported observation");
  }
});
lifecycle("fresh contract failure traces and archived prior trace stay separate", (fixture) => {
  const custody = owner(fixture);
  put(fixture, ".ci-artifacts/trace-body.txt", "diagnostic");
  const zip = (path) => {
    mkdirSync(dirname(join(fixture, path)), {recursive:true});
    good(execute(fixture, "zip", ["-q", join(fixture, path), ".ci-artifacts/trace-body.txt"]), "fixture ZIP");
  };
  zip(".ci-artifacts/playwright/stale/trace.zip");
  const oldHash = hash(join(fixture, ".ci-artifacts/playwright/stale/trace.zip"));
  const id = good(operation(fixture, custody, "prepare", "contract"), "contract prepare");
  outputs(fixture, "contract");
  zip(".ci-artifacts/playwright/fresh/trace.zip");
  good(operation(fixture, custody, "seal", "contract", id, "failure", "19"), "contract failure seal");
  good(sanitize(fixture, "contract"), "fresh failure trace sanitizer");
  const failed = JSON.parse(readFileSync(reportPath(fixture, "contract")));
  assert(failed.artifact_hashes.length === 3 && failed.artifact_hashes.some((a) => a.path.endsWith("fresh/trace.zip")), "fresh trace missing");
  assert(!failed.artifact_hashes.some((a) => a.path.endsWith("stale/trace.zip")), "stale trace rebound");
  assert(hash(join(history(fixture, id), "prior/working/.ci-artifacts/playwright/stale/trace.zip")) === oldHash, "old trace lost");
  rmSync(join(fixture, ".ci-artifacts/reports/playwright.xml"));
  good(wrapper(fixture, "contract", {BULLET_CI_PROOF_CUSTODY:custody}), "fresh contract after Hub XML deletion");
  good(sanitize(fixture, "contract"), "PASS exact contract inventory");
  assert(JSON.parse(readFileSync(reportPath(fixture, "contract"))).artifact_hashes.length === 2, "PASS trace inventory leak");
});
lifecycle("occupied incomplete generation refuses without destroying evidence", (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  const digest = hash(reportPath(fixture, "fast"));
  const path = ".ci-artifacts/lifecycle/generations/00000000-0000-4000-8000-000000000000/sentinel";
  put(fixture, path, "occupied");
  bad(wrapper(fixture, "fast"), "occupied incomplete generation");
  assert(hash(reportPath(fixture, "fast")) === digest && readFileSync(join(fixture,path), "utf8") === "occupied", "collision evidence changed");
  bad(observe(fixture, "fast", "success", "0"), "old PASS with incomplete collision");
});
lifecycle("process death while sealing retains partial state and refuses retry", (fixture) => {
  const custody = owner(fixture);
  const id = good(operation(fixture, custody, "prepare", "fast"), "prepare");
  outputs(fixture, "fast");
  put(fixture, "target/bin/npm", '#!/bin/sh\nkill -KILL "$PPID"\n');
  chmodSync(join(fixture, "target/bin/npm"), 0o700);
  const killed = execute(fixture, process.execPath, [producer, "seal", "fast", id, "success", "0"], {
    BULLET_CI_OBSERVATION_OWNER:custody, PATH:join(fixture,"target/bin")+":"+process.env.PATH,
  });
  assert(killed.signal === "SIGKILL", "seal process was not killed");
  assert(existsSync(join(history(fixture,id),"payload/.ci-artifacts/reports/vitest.json")), "partial payload absent");
  bad(observe(fixture,"fast","success","0"), "killed seal");
  bad(operation(fixture,custody,"prepare","fast"), "killed seal retry");
});
lifecycle("inherited owner survives nested refusal and standalone lock releases", (fixture) => {
  good(wrapper(fixture,"fast",{NESTED:"1"}), "standalone nested refusal");
  assert(!existsSync(join(fixture,".git/bullet-ci.lock.d")), "standalone lock leaked");
  const custody=owner(fixture);
  good(wrapper(fixture,"fast",{NESTED:"1",BULLET_CI_PROOF_CUSTODY:custody}), "family nested refusal");
  assert(readFileSync(join(fixture,".git/bullet-ci.lock.d/owner"),"utf8")===custody+"\n", "family owner changed");
  assert(readFileSync(join(fixture,".ci-artifacts/dispatch.log"),"utf8")==="fast\nfast\n", "nested child ran");
});
lifecycle("failed outcome cannot be relabelled cancelled or skipped", (fixture) => {
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"prepare");
  outputs(fixture,"fast");
  good(operation(fixture,custody,"seal","fast",id,"failure","19"),"failure seal");
  good(observe(fixture,"fast","failure","19"),"exact failure");
  for(const outcome of ["cancelled","skipped"]) bad(observe(fixture,"fast",outcome,"19","bash scripts/ci-local.sh fast"),"relabelled "+outcome);
});
lifecycle("active observation collision precedes completion", (fixture) => {
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"prepare");
  outputs(fixture,"fast");
  put(fixture,".ci-artifacts/observations/fast.json","occupied observation");
  bad(operation(fixture,custody,"seal","fast",id,"success","0"),"publication collision");
  assert(!existsSync(join(history(fixture,id),"completion.json")),"collision left completion");
  assert(readFileSync(reportPath(fixture,"fast"),"utf8")==="occupied observation","collision overwritten");
  bad(observe(fixture,"fast","success","0"),"collision success");
});
for (const phase of ["before", "after"]) lifecycle(`publication failure ${phase} rename remains incomplete`, (fixture) => {
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"prepare");
  outputs(fixture,"fast");
  put(fixture,"target/rename-fault.cjs", `const fs=require('node:fs');
const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b==='.ci-artifacts/observations/fast.json'){${phase === 'after' ? 'rename(a,b);' : ''}throw Error('INJECTED_PUBLICATION_FAILURE')}return rename(a,b)};
require('node:module').syncBuiltinESMExports();`);
  const result=execute(fixture,process.execPath,["--require","./target/rename-fault.cjs",producer,"seal","fast",id,"success","0"],{BULLET_CI_OBSERVATION_OWNER:custody});
  bad(result,"rename fault");
  assert(result.stderr.includes("INJECTED_PUBLICATION_FAILURE"),"fault did not reach rename");
  assert(existsSync(join(history(fixture,id),"completion.json")) && !existsSync(join(history(fixture,id),"publication.json")),"partial publication state");
  assert(existsSync(reportPath(fixture,"fast")) === (phase === "after"), "publication fault phase");
  const present=join(fixture,".ci-artifacts/present");
  bad(execute(fixture,"bash",["scripts/ci-observation.sh","fast","success","0"],{GITHUB_OUTPUT:present}),"failed publication success");
  assert(!existsSync(present),"incomplete publication present=true");
  bad(operation(fixture,custody,"prepare","fast"),"failed publication replacement");
});
lifecycle("orphan working payload hashes are retained and checked", (fixture) => {
  outputs(fixture,"fast");
  good(wrapper(fixture,"fast"),"fresh invocation over orphan reports");
  const id=generation(fixture,"fast");
  const prepared=JSON.parse(readFileSync(join(history(fixture,id),"prepared.json")));
  assert(prepared.retained_working.length===3,"orphan manifest incomplete");
  for(const artifact of prepared.retained_working) assert(hash(join(history(fixture,id),"prior/working",artifact.path))===artifact.sha256,"orphan hash missing");
  good(observe(fixture,"fast","success","0"),"normal orphan retention");
  writeFileSync(join(history(fixture,id),"prior/working",prepared.retained_working[0].path),"corrupted retained diagnostic");
  bad(observe(fixture,"fast","success","0"),"corrupted orphan accepted");
  bad(wrapper(fixture,"fast"),"corrupt orphan replacement");
});
for (const kind of ["working", "observation", "reference"]) lifecycle(`retained ${kind} corruption after prepare refuses seal`, (fixture) => {
  good(wrapper(fixture,"fast"),"previous sealed generation");
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"new prepare");
  outputs(fixture,"fast");
  const paths={working:"prior/working/.ci-artifacts/reports/vitest.json",observation:"prior/observations/fast.json",reference:"prior/references/fast/.ci-artifacts/reports/vitest.json"};
  writeFileSync(join(history(fixture,id),paths[kind]),"changed after prepare");
  bad(operation(fixture,custody,"seal","fast",id,"success","0"),"changed prior "+kind);
  assert(!existsSync(reportPath(fixture,"fast")) && !existsSync(join(history(fixture,id),"completion.json")),"seal published corrupt history");
});
console.log(`[ci] ${lifecycleCount} observation lifecycle pairs passed`);
