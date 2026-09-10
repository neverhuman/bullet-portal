// Original producer/consumer lifecycle assertions, run with real monitor custody.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copySources } from "./source-custody-fixture.mjs";
import { cleanupFixture, customOperation, finish, fixtureEnvironment, operation, releaseSession } from "./observation-lifecycle-fixture.mjs";
const script = resolve("ops/ci/sanitize-artifacts.mjs");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function assert(condition, message) { if (!condition) throw new Error(`CI_STAGE_TEST_FAILED: ${message}`); }


const producer = "ops/ci/observation.mjs";
const outputPolicy = {
  fast: ["reports/farmd-test-proxy-override.log", "reports/vite-api-override.log", "reports/vitest.json"],
  lint: [], contract: ["reports/bundle-tests.log"], security: [], docs: [],
  rendered: ["playwright/.last-run.json", "reports/playwright.xml"],
  "scheduled-hygiene": [], coverage: ["coverage/coverage-summary.json", "reports/coverage-tests.json"],
  portable: ["platform/refusal.json", "reports/farmd-test-proxy-override.log", "reports/vite-api-override.log", "reports/vitest.json"],
};
let lifecycleCount = 0;
const execute = (fixture, command, args, env = {}) => spawnSync(command, args, { cwd: fixture, encoding: "utf8", env: { ...process.env, ...fixtureEnvironment(fixture), ...env } });
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
async function lifecycle(label, check) {
  const fixture = mkdtempSync(join(process.env.BULLET_CI_FIXTURE_ROOT ?? tmpdir(), "bullet-portal-lifecycle-"));
  let succeeded = false;
  try {
    copySources(process.cwd(), fixture);
    for (const path of ["scripts/ci-observation.sh"]) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      copyFileSync(resolve(path), join(fixture, path));
    }
    put(fixture, ".gitignore", ".ci-artifacts/\ntarget/\n");
    put(fixture, "subject.txt", "source\n");
    // Synthetic custody tests execute fixture.mjs only, never a rendered tool.
    // Actual-host refusal is tested separately against the product helper.
    put(fixture, "ops/proof/rendered-host.ts", "export function requireRenderedHost() {}\n");
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
    good(spawnSync("git", ["init", "--quiet"], {cwd:fixture,encoding:"utf8"}), "fixture Git init");
    good(spawnSync("git", ["add", "."], {cwd:fixture,encoding:"utf8"}), "fixture add");
    good(spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], {cwd:fixture,encoding:"utf8"}), "fixture commit");
    await check(fixture);
    succeeded = true;
    lifecycleCount++;
    console.log(`[ci] lifecycle pair passed: ${label}`);
  } finally { await cleanupFixture(fixture, !succeeded); if (succeeded) rmSync(fixture, { recursive: true, force: true }); else console.error(`retained failed fixture: ${fixture}`); }
}

await lifecycle("every consumer lane inventory and unchanged legacy verification", async (fixture) => {
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
await lifecycle("stale exact reports plus no-op success refuse", async (fixture) => {
  outputs(fixture, "fast");
  bad(wrapper(fixture, "fast", { NO_OUTPUT: "1" }), "no-op stale outputs");
  bad(observe(fixture, "fast", "success", "0"), "incomplete invocation");
  assert(!existsSync(reportPath(fixture, "fast")), "stale PASS published");
});
await lifecycle("identical bytes and Hub pre-deletion create new retained generations", async (fixture) => {
  good(wrapper(fixture, "fast"), "first fast");
  const first = generation(fixture, "fast");
  const payload = join(history(fixture, first), "payload/.ci-artifacts/reports/vitest.json");
  const digest = hash(payload);
  rmSync(join(fixture, ".ci-artifacts/reports/vitest.json"));
  good(wrapper(fixture, "fast"), "identical fresh fast");
  assert(generation(fixture, "fast") !== first && hash(payload) === digest, "fresh generation/payload custody");
});
await lifecycle("overlapping fast and portable retire prior observations", async (fixture) => {
  for (const [before, after] of [["fast", "portable"], ["portable", "fast"]]) {
    good(wrapper(fixture, before), "overlap predecessor");
    const previous = generation(fixture, before);
    good(wrapper(fixture, after), "overlap successor");
    bad(observe(fixture, before, "success", "0"), "retired observation");
    good(sanitize(fixture, after), "selected overlap consumer");
    assert(existsSync(join(history(fixture, previous), "completion.json")), "retired completion lost");
  }
});
await lifecycle("legacy missing references retain explicit disposition", async (fixture) => {
  outputs(fixture, "fast");
  const refs = outputPolicy.fast.map((path) => ({path: `.ci-artifacts/${path}`, sha256: hash(join(fixture, `.ci-artifacts/${path}`))}));
  put(fixture, ".ci-artifacts/observations/fast.json", JSON.stringify({artifact_hashes:refs}));
  rmSync(join(fixture, ".ci-artifacts/reports/vitest.json"));
  good(wrapper(fixture, "fast"), "legacy adoption");
  const prepared = readFileSync(join(history(fixture, generation(fixture, "fast")), "prepared.json"), "utf8");
  assert(prepared.includes("MISSING_LEGACY_REFERENCE"), "missing legacy evidence invented");
});
await lifecycle("corrupt complete payload refuses replacement", async (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  put(fixture, `.ci-artifacts/lifecycle/generations/${generation(fixture, "fast")}/payload/.ci-artifacts/reports/vitest.json`, "corrupt");
  bad(wrapper(fixture, "fast"), "corrupt historical payload");
  bad(observe(fixture, "fast", "success", "0"), "corrupt legacy verification");
});
for (const mutation of ["replace", "delete"]) await lifecycle(`sealed output ${mutation} rejects emitter and sanitizer`, async (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  const before = hash(reportPath(fixture, "fast"));
  const path = join(fixture, ".ci-artifacts/reports/vitest.json");
  if (mutation === "replace") writeFileSync(path, "replacement"); else rmSync(path);
  bad(observe(fixture, "fast", "success", "0"), mutation);
  bad(sanitize(fixture, "fast"), mutation + " sanitizer");
  assert(hash(reportPath(fixture, "fast")) === before, "failed emitter rewrote hashes");
});
await lifecycle("missing preparation and argument drift cannot set hosted present", async (fixture) => {
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
for (const phase of ["pending", "prepared", "completion"]) await lifecycle(`interrupted ${phase} cannot restore old PASS`, async (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  const custody = owner(fixture);
  const id = good(operation(fixture, custody, "prepare", "fast"), "new prepare");
  if (phase === "pending") rmSync(join(history(fixture, id), "prepared.json"));
  if (phase === "completion") {
    outputs(fixture, "fast");
    good(operation(fixture, custody, "seal", "fast", id, "success", "0"), "seal before interruption");
    good(finish(fixture), "finish before completion interruption");
    rmSync(join(history(fixture, id), "completion.json"));
  }
  bad(observe(fixture, "fast", "success", "0"), "interrupted " + phase);
  bad(operation(fixture, custody, "prepare", "fast"), "unfinished replacement");
});
await lifecycle("source and generation identity drift refuse seal", async (fixture) => {
  const custody = owner(fixture);
  const id = good(operation(fixture, custody, "prepare", "fast"), "prepare");
  outputs(fixture, "fast");
  bad(operation(fixture, custody, "seal", "fast", "00000000-0000-4000-8000-000000000000", "success", "0"), "wrong generation");
  put(fixture, "subject.txt", "changed");
  bad(operation(fixture, custody, "seal", "fast", id, "success", "0"), "changed source");
});
for (const target of [".ci-artifacts", ".ci-artifacts/reports", ".ci-artifacts/reports/vitest.json"]) await lifecycle(`symlink boundary ${target}`, async (fixture) => {
  put(fixture, "target/outside/file", "sentinel");
  const outside = join(fixture, "target/outside");
  mkdirSync(dirname(join(fixture, target)), {recursive:true});
  symlinkSync(target.endsWith(".json") ? join(outside, "file") : outside, join(fixture, target));
  bad(wrapper(fixture, "fast"), "symlink prepare");
  assert(readFileSync(join(outside, "file"), "utf8") === "sentinel", "outside bytes changed");
});
await lifecycle("failed child preserves partial FAIL and original status", async (fixture) => {
  const result = wrapper(fixture, "fast", { FAIL_LANE: "fast", PARTIAL: "1" });
  assert(result.status === 19, "child failure lost");
  good(observe(fixture, "fast", "failure", "19"), "failure verification");
  good(sanitize(fixture, "fast"), "partial failure sanitization");
  assert(JSON.parse(readFileSync(reportPath(fixture, "fast"))).artifact_hashes.length === 2, "partial inventory plus monitor proof");
});
await lifecycle("failed seal cannot hide child failure", async (fixture) => {
  const result = wrapper(fixture, "fast", { FAIL_LANE: "fast", CHANGE_SOURCE: "1" });
  assert(result.status === 19, "seal failure replaced child status");
  bad(observe(fixture, "fast", "success", "0"), "failed seal green");
});
await lifecycle("inherited required custody, exact order, disjoint artifacts and real aggregate", async (fixture) => {
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
await lifecycle("required stops at first failed child", async (fixture) => {
  assert(wrapper(fixture, "required", {FAIL_LANE:"lint"}).status === 19, "required failure status");
  assert(readFileSync(join(fixture, ".ci-artifacts/dispatch.log"), "utf8") === "fast\nlint\n", "required continued after failure");
});
await lifecycle("retained diagnostics remain in broad secret scan", async (fixture) => {
  outputs(fixture, "fast");
  put(fixture, ".ci-artifacts/reports/vitest.json", "gh" + "p_" + "A".repeat(36));
  good(wrapper(fixture, "fast"), "fresh generation over secret diagnostic");
  bad(sanitize(fixture, "fast"), "retained secret");
});
await lifecycle("unsupported evidence leaves preserve execution and refuse emitter", async (fixture) => {
  for (const lane of ["family", "nightly", "audit", "packaged-farmd"]) {
    good(wrapper(fixture, lane), "unsupported evidence dispatch");
    bad(observe(fixture, lane, "success", "0"), "unsupported observation");
  }
});
await lifecycle("fresh rendered failure traces and archived prior trace stay separate", async (fixture) => {
  const custody = owner(fixture);
  put(fixture, ".ci-artifacts/trace-body.txt", "diagnostic");
  const zip = (path) => {
    mkdirSync(dirname(join(fixture, path)), {recursive:true});
    good(execute(fixture, "zip", ["-q", join(fixture, path), ".ci-artifacts/trace-body.txt"]), "fixture ZIP");
  };
  zip(".ci-artifacts/playwright/stale/trace.zip");
  const oldHash = hash(join(fixture, ".ci-artifacts/playwright/stale/trace.zip"));
  const id = good(operation(fixture, custody, "prepare", "rendered"), "rendered prepare");
  outputs(fixture, "rendered");
  zip(".ci-artifacts/playwright/fresh/trace.zip");
  good(operation(fixture, custody, "seal", "rendered", id, "failure", "19"), "rendered failure seal");
  good(finish(fixture, 19), "rendered monitored completion");
  await releaseSession(fixture);
  good(sanitize(fixture, "rendered"), "fresh failure trace sanitizer");
  const failed = JSON.parse(readFileSync(reportPath(fixture, "rendered")));
  assert(failed.artifact_hashes.length === 4 && failed.artifact_hashes.some((a) => a.path.endsWith("fresh/trace.zip")), "fresh trace missing");
  assert(!failed.artifact_hashes.some((a) => a.path.endsWith("stale/trace.zip")), "stale trace rebound");
  assert(hash(join(history(fixture, id), "prior/working/.ci-artifacts/playwright/stale/trace.zip")) === oldHash, "old trace lost");
  rmSync(join(fixture, ".ci-artifacts/reports/playwright.xml"));
  good(wrapper(fixture, "rendered", {BULLET_CI_PROOF_CUSTODY:custody}), "fresh rendered after Hub XML deletion");
  good(sanitize(fixture, "rendered"), "PASS exact rendered inventory");
  assert(JSON.parse(readFileSync(reportPath(fixture, "rendered"))).artifact_hashes.length === 3, "PASS trace inventory including proof");
});
await lifecycle("occupied incomplete generation refuses without destroying evidence", async (fixture) => {
  good(wrapper(fixture, "fast"), "initial fast");
  const digest = hash(reportPath(fixture, "fast"));
  const path = ".ci-artifacts/lifecycle/generations/00000000-0000-4000-8000-000000000000/sentinel";
  put(fixture, path, "occupied");
  bad(wrapper(fixture, "fast"), "occupied incomplete generation");
  assert(hash(reportPath(fixture, "fast")) === digest && readFileSync(join(fixture,path), "utf8") === "occupied", "collision evidence changed");
  bad(observe(fixture, "fast", "success", "0"), "old PASS with incomplete collision");
});
await lifecycle("process death while sealing retains partial state and refuses retry", async (fixture) => {
  const custody = owner(fixture);
  const id = good(operation(fixture, custody, "prepare", "fast"), "prepare");
  outputs(fixture, "fast");
  put(fixture, "target/bin/npm", '#!/bin/sh\nkill -KILL "$PPID"\n');
  chmodSync(join(fixture, "target/bin/npm"), 0o700);
  const killed = customOperation(fixture, custody, process.execPath, [producer, "seal", "fast", id, "success", "0"], {
    BULLET_CI_OBSERVATION_OWNER:custody, PATH:join(fixture,"target/bin")+":"+process.env.PATH,
  });
  assert(killed.signal === "SIGKILL", "seal process was not killed");
  assert(existsSync(join(history(fixture,id),"payload/.ci-artifacts/reports/vitest.json")), "partial payload absent");
  bad(observe(fixture,"fast","success","0"), "killed seal");
  bad(operation(fixture,custody,"prepare","fast"), "killed seal retry");
});
await lifecycle("inherited owner survives nested refusal and standalone lock releases", async (fixture) => {
  good(wrapper(fixture,"fast",{NESTED:"1"}), "standalone nested refusal");
  assert(!existsSync(join(fixture,".git/bullet-ci.lock.d")), "standalone lock leaked");
  const custody=owner(fixture);
  good(wrapper(fixture,"fast",{NESTED:"1",BULLET_CI_PROOF_CUSTODY:custody}), "family nested refusal");
  assert(readFileSync(join(fixture,".git/bullet-ci.lock.d/owner"),"utf8")===custody+"\n", "family owner changed");
  assert(readFileSync(join(fixture,".ci-artifacts/dispatch.log"),"utf8")==="fast\nfast\n", "nested child ran");
});
await lifecycle("failed outcome cannot be relabelled cancelled or skipped", async (fixture) => {
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"prepare");
  outputs(fixture,"fast");
  good(operation(fixture,custody,"seal","fast",id,"failure","19"),"failure seal");
  good(finish(fixture,19),"failure monitor completion");
  good(observe(fixture,"fast","failure","19"),"exact failure");
  for(const outcome of ["cancelled","skipped"]) bad(observe(fixture,"fast",outcome,"19","bash scripts/ci-local.sh fast"),"relabelled "+outcome);
});
await lifecycle("active observation collision precedes completion", async (fixture) => {
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"prepare");
  outputs(fixture,"fast");
  put(fixture,".ci-artifacts/observations/fast.json","occupied observation");
  good(operation(fixture,custody,"seal","fast",id,"success","0"),"stage before publication collision");
  bad(finish(fixture),"publication collision");
  assert(!existsSync(join(history(fixture,id),"completion.json")),"collision left completion");
  assert(readFileSync(reportPath(fixture,"fast"),"utf8")==="occupied observation","collision overwritten");
  bad(observe(fixture,"fast","success","0"),"collision success");
});
for (const phase of ["before", "after"]) await lifecycle(`publication failure ${phase} rename remains incomplete`, async (fixture) => {
  const custody=owner(fixture);
  const id=good(operation(fixture,custody,"prepare","fast"),"prepare");
  outputs(fixture,"fast");
  put(fixture,"target/rename-fault.cjs", `const fs=require('node:fs');
const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b==='.ci-artifacts/observations/fast.json'){${phase === 'after' ? 'rename(a,b);' : ''}throw Error('INJECTED_PUBLICATION_FAILURE')}return rename(a,b)};
require('node:module').syncBuiltinESMExports();`);
  good(operation(fixture,custody,"seal","fast",id,"success","0"),"stage before publication fault");
  const result=finish(fixture,0,["--require","./target/rename-fault.cjs"]);
  bad(result,"rename fault");
  assert(result.stderr.includes("INJECTED_PUBLICATION_FAILURE"),"fault did not reach rename");
  assert(existsSync(join(history(fixture,id),"completion.json")) && !existsSync(join(history(fixture,id),"publication.json")),"partial publication state");
  assert(existsSync(reportPath(fixture,"fast")) === (phase === "after"), "publication fault phase");
  const present=join(fixture,".ci-artifacts/present");
  bad(execute(fixture,"bash",["scripts/ci-observation.sh","fast","success","0"],{GITHUB_OUTPUT:present}),"failed publication success");
  assert(!existsSync(present),"incomplete publication present=true");
  bad(operation(fixture,custody,"prepare","fast"),"failed publication replacement");
});
await lifecycle("orphan working payload hashes are retained and checked", async (fixture) => {
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
for (const kind of ["working", "observation", "reference"]) await lifecycle(`retained ${kind} corruption after prepare refuses seal`, async (fixture) => {
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
