import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { admit, copySources, hash } from "./source-custody-fixture.mjs";

const origin = process.cwd();
const fixtureRoot = mkdtempSync(join(tmpdir(), "bullet-source-custody-"));
process.env.BULLET_CI_FIXTURE_ROOT = fixtureRoot;
const fixtures = [];
const observations = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
async function until(probe, label) {
  for (let i = 0; i < 1000; i++) { const value = probe(); if (value) return value; await delay(20); }
  throw new Error(`fixture deadline: ${label}`);
}
function fixture(name, mode = "plain", lane = "fast", prepareLookups = () => []) {
  const f = { name, repo: join(fixtureRoot, name), child: null, output: "", verifications: [], mode, lane, fifo: null };
  fixtures.push(f); // Registered before any process can start or READY can fail.
  mkdirSync(f.repo);
  copySources(origin, f.repo);
  execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet", "--initial-branch=main", f.repo]);
  writeFileSync(join(f.repo, ".gitignore"), "/.ci-artifacts/\n/ready\n/release\n/node_modules/\n");
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, "node_modules/tool.js"), "export const value = 1;\n");
  if (mode === "reuse-hold") writeFileSync(join(f.repo, "node_modules/large-input"), Buffer.alloc(64 * 1024 * 1024, 120));
  if (mode === "startup-path") {
    for (let i = 0; i < 12000; i++) writeFileSync(join(f.repo, "node_modules", `watch-${String(i).padStart(5, "0")}`), "");
  }
  const gate = `${f.repo}.source-admission/compile-gate`;
  writeFileSync(join(f.repo, "input.rs"), `const GATE: &str = include_str!(${JSON.stringify(gate)});\npub fn answer() -> usize { GATE.len() }\n`);
  const reports = "mkdir -p .ci-artifacts/reports\nfor name in vitest.json vite-api-override.log farmd-test-proxy-override.log; do printf 'report\\n' >.ci-artifacts/reports/$name; done\n";
  const hold = ": >ready\nwhile [[ ! -e release ]]; do sleep 0.02; done\n" + (mode === "hold-failure" ? "exit 19\n" : "");
  const compile = '"$BULLET_CI_SOURCE_RUSTC" --crate-type=lib --edition=2024 input.rs -o .ci-artifacts/fixture.rlib\nprintf \'0\\n\' >.ci-artifacts/compiler-exit\n';
  writeFileSync(join(f.repo, "ops/ci/fast.sh"), `#!/usr/bin/env bash\nset -euo pipefail\n${reports}${mode === "compile" ? compile : ["hold", "hold-failure"].includes(mode) && lane !== "required" ? hold : ""}`);
  if (lane === "required") {
    writeFileSync(join(f.repo, "ops/ci/lint.sh"), `#!/usr/bin/env bash\nset -euo pipefail\n${hold}`);
    writeFileSync(join(f.repo, "ops/ci/contract.sh"), "#!/usr/bin/env bash\nprintf 'bundle fixture\\n' >.ci-artifacts/reports/bundle-tests.log\n");
    for (const other of ["security", "docs"]) writeFileSync(join(f.repo, `ops/ci/${other}.sh`), "#!/usr/bin/env bash\nexit 0\n");
  }
  const lookups = prepareLookups(f);
  execFileSync("git", ["-C", f.repo, "add", "."]);
  execFileSync("git", ["-C", f.repo, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "source custody fixture"]);
  f.head = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  f.tree = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  f.env = { ...process.env };
  if (mode === "seal-hold") {
    const tools = `${f.repo}.tools`; mkdirSync(tools);
    f.npm = join(tools, "npm");
    writeFileSync(f.npm, `#!/usr/bin/env bash\n: >${JSON.stringify(join(f.repo, "ready"))}\nwhile [[ ! -e ${JSON.stringify(join(f.repo, "release"))} ]]; do sleep 0.02; done\nprintf '10.9.8\\n'\n`, { mode: 0o700 });
    f.env.PATH = `${tools}:${process.env.PATH}`;
  }
  const priorPath = process.env.PATH; process.env.PATH = f.env.PATH;
  try { f.admission = admit(f.repo, [lane], mode === "seal-hold" ? ["npm"] : [], [], lookups); }
  finally { process.env.PATH = priorPath; }
  f.env.PATH = f.admission.tool_path;
  if (mode === "compile") { execFileSync("mkfifo", ["-m", "600", gate]); f.fifo = gate; }
  return f;
}
function launch(f, overrides = {}) {
  f.retired = false;
  f.child = spawn("bash", ["scripts/ci-local.sh", f.lane], { cwd: f.repo, detached: true,
    env: { ...f.env, BULLET_CI_SOURCE_ADMISSION: f.admission.path, BULLET_CI_SOURCE_ADMISSION_SHA256: f.admission.sha256, ...overrides },
    stdio: ["ignore", "pipe", "pipe"] });
  f.child.stdout.on("data", (bytes) => { f.output += bytes; });
  f.child.stderr.on("data", (bytes) => { f.output += bytes; });
  f.exit = new Promise((resolve, reject) => { f.child.once("error", reject); f.child.once("close", (code, signal) => { f.retired = true; resolve({ code, signal }); }); });
}
function session(f) {
  const path = join(f.repo, ".ci-artifacts/source-proof");
  if (!existsSync(path)) return null;
  return readdirSync(path).map((id) => join(path, id)).find((p) => existsSync(join(p, "ack-00000000.json"))) ?? null;
}
async function ready(f) {
  return until(() => { const p = session(f); return p ? json(join(p, "ack-00000000.json")) : null; }, "monitor READY");
}
async function finish(f) {
  let timer;
  try {
    const result = await Promise.race([f.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`wrapper completion deadline: ${f.output}`)), 30_000); })]);
    return { ...result, output: f.output };
  } finally { clearTimeout(timer); }
}
function assertUnpublished(f) {
  const path = join(f.repo, ".ci-artifacts/observations");
  assert.deepEqual(existsSync(path) ? readdirSync(path) : [], [], f.output);
}
function restored(path) {
  const before = readFileSync(path); const digest = hash(path);
  writeFileSync(path, Buffer.concat([before, Buffer.from("\ntransient\n")])); writeFileSync(path, before);
  assert.equal(hash(path), digest); return digest;
}
function assertSameGit(f) {
  assert.equal(execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), f.head);
  assert.equal(execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(), f.tree);
}
function externalLookup(kind) {
  return (f) => {
    f.external = `${f.repo}.external`;
    mkdirSync(f.external); mkdirSync(join(f.external, "real"));
    f.target = join(f.external, "real/config"); writeFileSync(f.target, "actual config\n");
    f.alias = join(f.external, "alias");
    if (kind === "absent" || kind === "missing-ancestor") {
      f.missing = join(f.external, kind === "absent" ? "missing" : "missing/child/config");
      return [{ path: f.missing, kind: "absent", target: null }];
    }
    symlinkSync(kind === "ancestor-alias" ? "real" : "real/config", f.alias);
    f.lookup = kind === "ancestor-alias" ? join(f.alias, "config") : f.alias;
    return [{ path: f.lookup, kind: "file", target: f.target }];
  };
}
function verify(f, overrides = {}) {
  const env = { ...f.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  // A completed fixture is recovered outside the enclosing proof's live
  // session. Keep tool/configuration subjects; remove only live custody context.
  for (const key of ["BULLET_CI_PROOF_CUSTODY", "BULLET_CI_OBSERVATION_OWNER", "BULLET_CI_SOURCE_SESSION",
    "BULLET_CI_SOURCE_OWNER_PID", "BULLET_CI_SOURCE_MONITOR_PID", "BULLET_CI_SOURCE_MONITOR_START",
    "BULLET_CI_SOURCE_READ_FD", "BULLET_CI_SOURCE_WRITE_FD", "BULLET_CI_SOURCE_RESPONSE_SECONDS", "BULLET_CI_SOURCE_CHILD_STARTED"]) delete env[key];
  delete env.GIT_OPTIONAL_LOCKS; // The semantic consumer itself must keep reads observational.
  const result = spawnSync("node", ["ops/ci/observation.mjs", "fast", "success", "0"], { cwd: f.repo,
    env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000 });
  f.verifications.push({ status: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdout: result.stdout, stderr: result.stderr });
  return result;
}
async function case_(name, body) {
  try { const detail = await body(); observations.push({ name, status: "PASS", detail }); }
  catch (error) { observations.push({ name, status: "FAIL", error: String(error.stack) }); throw error; }
}
let failed = false;
try {
  for (const lane of ["fast", "required"]) for (const failedChild of [false, true]) {
    await case_(`monitor-loss-${lane}-preserves-child-${failedChild ? "19" : "0"}`, async () => {
      const f = fixture(`status-${lane}-${failedChild}`, failedChild ? "hold-failure" : "hold", lane, externalLookup("absent"));
      launch(f); await until(() => existsSync(join(f.repo, "ready")), "status lane ready");
      writeFileSync(f.missing, "transient"); unlinkSync(f.missing);
      writeFileSync(join(f.repo, "release"), "");
      const result = await finish(f); assert.equal(result.code, failedChild ? 19 : 75, result.output);
      assertUnpublished(f);
      const refusal = json(join(session(f), "refused.json"));
      assert.equal(refusal.child_exit, failedChild ? 19 : lane === "required" ? 75 : 0);
      assert.notEqual(refusal.monitor_exit, 0);
      assert.match(result.output, /CI_SOURCE_CUSTODY/);
      return { ...result, refusal };
    });
  }
  for (const mode of ["unchanged", "middle-restore", "target-restore", "directory-child", "undeclared", "wrong", "excluded", "later-reuse"]) {
    await case_(`declared-recursive-alias-${mode}`, async () => {
      const negative = ["undeclared", "wrong", "excluded"].includes(mode);
      const mutating = ["middle-restore", "target-restore", "directory-child"].includes(mode);
      const f = fixture(`recursive-${mode}`, mutating ? "hold" : "plain", "fast", (f) => {
        const lookup = externalLookup(mode === "directory-child" ? "ancestor-alias" : "final-alias")(f)[0];
        const link = join(f.repo, "declared-root-alias"); symlinkSync(f.alias, link); lookup.path = link;
        if (mode === "directory-child") { lookup.kind = "directory"; lookup.target = join(f.external, "real"); }
        if (mode === "wrong") lookup.target = join(f.external, "wrong");
        if (mode === "excluded") {
          mkdirSync(join(f.repo, ".ci-artifacts")); f.target = join(f.repo, ".ci-artifacts/private-input");
          writeFileSync(f.target, "excluded"); unlinkSync(f.alias); symlinkSync(f.target, f.alias); lookup.target = f.target;
        }
        return mode === "undeclared" ? [] : [lookup];
      });
      const replaceMiddle = () => {
        renameSync(f.alias, join(f.external, "saved-middle")); symlinkSync("real/config", f.alias);
        unlinkSync(f.alias); renameSync(join(f.external, "saved-middle"), f.alias);
      };
      launch(f);
      if (mutating) {
        await until(() => existsSync(join(f.repo, "ready")), "declared recursive alias ready");
        if (mode === "middle-restore") replaceMiddle();
        else if (mode === "target-restore") restored(f.target);
        else { const child = join(f.external, "real/new-child"); writeFileSync(child, "transient"); unlinkSync(child); }
        writeFileSync(join(f.repo, "release"), "");
      }
      const result = await finish(f);
      if (negative || mutating) {
        assert.equal(result.code, 75, result.output); assertUnpublished(f);
        assert.match(result.output, negative ? /INDIRECT_SYMLINK_INPUT_REFUSED|LOOKUP_TARGET_DIFFERS|LOOKUP_INTERSECTS_EXCLUDED_OUTPUT/ : /SOURCE_MUTATION|WATCH_LOST/);
      } else {
        assert.equal(result.code, 0, result.output); const recovery = verify(f); assert.equal(recovery.status, 0, recovery.stderr);
        if (mode === "later-reuse") {
          unlinkSync(f.alias); symlinkSync("real/config", f.alias);
          const later = verify(f); assert.notEqual(later.status, 0); assert.match(later.stderr, /CURRENT_LOOKUP_INVENTORY_CHANGED/);
          return { ...result, later_revalidation: later.stderr };
        }
      }
      return result;
    });
  }
  for (const kind of ["absent", "missing-ancestor", "final-alias", "ancestor-alias", "target", "sibling"]) {
    await case_(`external-lookup-${kind}-live-custody`, async () => {
      const f = fixture(`lookup-${kind}`, "hold", "fast", externalLookup(kind));
      launch(f); await until(() => existsSync(join(f.repo, "ready")), "lookup lane ready");
      const inventory = json(join(session(f), "inventory.json"));
      assert.equal(Object.keys(inventory.lookups).length, 1);
      if (kind === "absent") { writeFileSync(f.missing, "transient"); unlinkSync(f.missing); }
      else if (kind === "missing-ancestor") { mkdirSync(join(f.external, "missing")); rmSync(join(f.external, "missing"), { recursive: true }); }
      else if (kind.endsWith("alias")) {
        renameSync(f.alias, join(f.external, "original-alias"));
        symlinkSync(kind === "ancestor-alias" ? "real" : "real/config", f.alias);
        unlinkSync(f.alias); renameSync(join(f.external, "original-alias"), f.alias);
      } else if (kind === "target") restored(f.target);
      else { writeFileSync(join(f.external, "unrelated"), "allowed"); unlinkSync(join(f.external, "unrelated")); }
      writeFileSync(join(f.repo, "release"), "");
      const result = await finish(f);
      if (kind === "sibling") { assert.equal(result.code, 0, result.output); const recovery = verify(f); assert.equal(recovery.status, 0, recovery.stderr); }
      else { assert.equal(result.code, 75, result.output); assertUnpublished(f); assert.match(result.output, /SOURCE_MUTATION|WATCH_LOST/); }
      return { ...result, lookup_inventory: inventory.lookups };
    });
  }
  for (const kind of ["absent", "final-alias", "target"]) {
    await case_(`external-lookup-${kind}-later-drift-refuses-reuse`, async () => {
      const f = fixture(`lookup-reuse-${kind}`, "plain", "fast", externalLookup(kind));
      launch(f); assert.equal((await finish(f)).code, 0, f.output);
      const recovery = verify(f); assert.equal(recovery.status, 0, recovery.stderr);
      if (kind === "absent") writeFileSync(f.missing, "new configuration");
      else if (kind === "final-alias") { unlinkSync(f.alias); symlinkSync("real/config", f.alias); }
      else writeFileSync(f.target, "different config");
      const result = verify(f); assert.notEqual(result.status, 0);
      assert.match(result.stderr, /LOOKUP_TARGET_DIFFERS|CURRENT_LOOKUP_INVENTORY_CHANGED/);
      return { status: result.status, stderr: result.stderr };
    });
  }
  await case_("external-lookup-wrong-admitted-target-prevents-launch", async () => {
    const f = fixture("lookup-wrong-target", "hold", "fast", (f) => {
      const lookups = externalLookup("final-alias")(f); lookups[0].target = join(f.external, "other"); return lookups;
    });
    launch(f); const result = await finish(f);
    assert.equal(result.code, 75, result.output); assertUnpublished(f);
    assert.equal(existsSync(join(f.repo, "ready")), false); assert.match(result.output, /LOOKUP_TARGET_DIFFERS/);
    return result;
  });
  await case_("unchanged-wrapper-publishes-after-final-zero-exit", async () => {
    const f = fixture("unchanged"); launch(f); const result = await finish(f);
    assert.equal(result.code, 0, result.output);
    const proof = json(join(f.repo, ".ci-artifacts/reports/fast-source-proof.json"));
    assert.equal(proof.monitor_exit, 0); assert.equal(proof.acknowledgements.at(-1).command, "FINISHED");
    assert.equal(json(join(f.repo, ".ci-artifacts/observations/fast.json")).outcomes[0].status, "PASS");
    return { ...result, proof_sha256: hash(join(f.repo, ".ci-artifacts/reports/fast-source-proof.json")) };
  });
  for (const mutate of [false, true]) await case_(`real-compilation-${mutate ? "restored-write-refuses" : "unchanged-passes"}`, async () => {
    const f = fixture(`compile-${mutate}`, "compile"); launch(f); const ack = await ready(f);
    let writer;
    await until(() => { try { writer = openSync(f.fifo, constants.O_WRONLY | constants.O_NONBLOCK); return true; } catch (error) { if (error.code !== "ENXIO") throw error; return false; } }, "rustc include expansion");
    const digest = mutate ? restored(join(f.repo, "input.rs")) : hash(join(f.repo, "input.rs"));
    closeSync(writer); // Empty include is valid and releases the actual compiler.
    const result = await finish(f);
    assert.equal(readFileSync(join(f.repo, ".ci-artifacts/compiler-exit"), "utf8"), "0\n");
    assertSameGit(f); assert.equal(hash(join(f.repo, "input.rs")), digest);
    if (mutate) {
      assert.notEqual(result.code, 0, result.output); assertUnpublished(f);
      assert.match(result.output, /SOURCE_MUTATION/);
      assert.equal(json(join(session(f), "refused.json")).child_exit, 0);
    } else assert.equal(result.code, 0, result.output);
    return { ...result, ack, source_sha256_before_and_after: digest, compiler_exit: 0, head: f.head, tree: f.tree };
  });
  for (const mode of ["hold", "seal-hold"]) await case_(`monitor-death-during-${mode === "hold" ? "dispatch" : "seal"}`, async () => {
    const f = fixture(mode, mode); launch(f); const ack = await ready(f);
    await until(() => existsSync(join(f.repo, "ready")), "selected boundary");
    process.kill(ack.monitor_pid, "SIGKILL"); writeFileSync(join(f.repo, "release"), "");
    const result = await finish(f); assert.notEqual(result.code, 0, result.output); assertUnpublished(f);
    assert.equal(json(join(session(f), "refused.json")).child_exit, 0);
    return result;
  });
  for (const kind of ["index", "source", "tool"]) await case_(`restored-${kind}-invalidates-complete-generation`, async () => {
    const f = fixture(`restore-${kind}`, kind === "tool" ? "seal-hold" : "hold"); launch(f); await ready(f);
    await until(() => existsSync(join(f.repo, "ready")), "mutation boundary");
    const target = kind === "index" ? join(f.repo, ".git/index") : kind === "tool" ? f.npm : join(f.repo, "input.rs");
    const digest = restored(target); writeFileSync(join(f.repo, "release"), "");
    const result = await finish(f); assert.notEqual(result.code, 0, result.output); assertUnpublished(f); assertSameGit(f);
    return { ...result, ending_sha256: digest };
  });
  await case_("required-prior-passing-stage-is-not-published-after-mutation", async () => {
    const f = fixture("required", "plain", "required"); launch(f); await ready(f);
    await until(() => existsSync(join(f.repo, "ready")), "second required lane");
    const generations = join(f.repo, ".ci-artifacts/lifecycle/generations");
    assert(readdirSync(generations).some((id) => existsSync(join(generations, id, "sealed.json"))));
    assertUnpublished(f); restored(join(f.repo, "input.rs")); writeFileSync(join(f.repo, "release"), "");
    const result = await finish(f); assert.notEqual(result.code, 0, result.output); assertUnpublished(f);
    assert(readdirSync(generations).every((id) => existsSync(join(generations, id, "invalidated.json"))));
    return result;
  });
  await case_("old-receipt-cannot-bypass-missing-admission", async () => {
    const f = fixture("receipt"); launch(f); assert.equal((await finish(f)).code, 0, f.output);
    const proof = hash(join(f.repo, ".ci-artifacts/reports/fast-source-proof.json"));
    launch(f, { BULLET_CI_SOURCE_ADMISSION_SHA256: "0".repeat(64) }); const result = await finish(f);
    assert.notEqual(result.code, 0); assert.match(result.output, /SOURCE_ADMISSION_REQUIRED/);
    assert.equal(hash(join(f.repo, ".ci-artifacts/reports/fast-source-proof.json")), proof);
    return result;
  });
  await case_("new-path-executable-invalidates-source-generation", async () => {
    const f = fixture("path-insertion", "hold"); launch(f); await ready(f);
    await until(() => existsSync(join(f.repo, "ready")), "PATH insertion boundary");
    writeFileSync(join(f.admission.tool_path, "new-selected-tool"), "#!/bin/false\n", { mode: 0o700 });
    writeFileSync(join(f.repo, "release"), "");
    const result = await finish(f); assert.notEqual(result.code, 0, result.output); assertUnpublished(f);
    assert.match(result.output, /SOURCE_MUTATION/); return result;
  });
  await case_("changed-admission-with-old-review-refuses", async () => {
    const f = fixture("review-drift"); const admission = json(f.admission.path);
    admission.max_seconds += 1;
    writeFileSync(f.admission.path, JSON.stringify(admission)); f.admission.sha256 = hash(f.admission.path);
    launch(f); const result = await finish(f);
    assert.notEqual(result.code, 0); assert.match(result.output, /EXACT_INDEPENDENT_ADMISSION_REVIEW_REQUIRED/); assertUnpublished(f);
    assert.equal(existsSync(join(f.repo, ".ci-artifacts/reports/vitest.json")), false); return result;
  });
  await case_("second-valid-run-creates-fresh-monitor-generation", async () => {
    const f = fixture("fresh-proof"); launch(f); assert.equal((await finish(f)).code, 0, f.output);
    const before = json(join(f.repo, ".ci-artifacts/reports/fast-source-proof.json"));
    launch(f); const result = await finish(f); assert.equal(result.code, 0, result.output);
    const after = json(join(f.repo, ".ci-artifacts/reports/fast-source-proof.json"));
    assert.notEqual(before.binding.session, after.binding.session);
    assert.notEqual(before.acknowledgements[0].nonce, after.acknowledgements[0].nonce);
    assert.notEqual(before.binding.inventory_sha256, after.binding.inventory_sha256);
    return { ...result, first_session: before.binding.session, second_session: after.binding.session };
  });
  await case_("completed-unchanged-proof-revalidates-after-lock-removal", async () => {
    const f = fixture("reuse-valid"); launch(f); assert.equal((await finish(f)).code, 0, f.output);
    assert.equal(existsSync(join(f.repo, ".git/bullet-ci.lock.d")), false);
    const result = verify(f); assert.equal(result.status, 0, result.stderr); return { status: result.status };
  });
  await case_("historical-recovery-isolates-inherited-session-but-explicit-foreign-session-refuses", async () => {
    const foreign = fixture("foreign-session"); launch(foreign); assert.equal((await finish(foreign)).code, 0, foreign.output);
    const f = fixture("isolated-recovery"); f.env.BULLET_CI_SOURCE_SESSION = session(foreign);
    launch(f); assert.equal((await finish(f)).code, 0, f.output);
    const path = join(f.repo, ".ci-artifacts/observations/fast.json"); const digest = hash(path);
    assert.notEqual(session(f), f.env.BULLET_CI_SOURCE_SESSION);
    const recovered = verify(f); assert.equal(recovered.status, 0, recovered.stderr);
    const refused = verify(f, { BULLET_CI_SOURCE_SESSION: f.env.BULLET_CI_SOURCE_SESSION });
    assert.equal(refused.status, 75, refused.stderr); assert.match(refused.stderr, /CI_SOURCE_CUSTODY: SOURCE_SESSION_REQUIRED/);
    const recoveredAgain = verify(f); assert.equal(recoveredAgain.status, 0, recoveredAgain.stderr);
    assert.equal(f.env.BULLET_CI_SOURCE_SESSION, session(foreign)); assert.equal(hash(path), digest);
    return { recovered: recovered.status, explicit_foreign: refused.status, recovered_again: recoveredAgain.status, observation_sha256: digest };
  });
  for (const kind of ["ignored-dependency", "assume-unchanged-source", "external-tool"]) await case_(`completed-proof-refuses-${kind}-drift`, async () => {
    const f = fixture(`reuse-${kind}`, kind === "external-tool" ? "seal-hold" : "plain");
    launch(f);
    if (kind === "external-tool") { await until(() => existsSync(join(f.repo, "ready")), "tool seal"); writeFileSync(join(f.repo, "release"), ""); }
    assert.equal((await finish(f)).code, 0, f.output);
    if (kind === "assume-unchanged-source") execFileSync("git", ["-C", f.repo, "update-index", "--assume-unchanged", "input.rs"]);
    const target = kind === "ignored-dependency" ? join(f.repo, "node_modules/tool.js") : kind === "external-tool" ? f.npm : join(f.repo, "input.rs");
    writeFileSync(target, `${readFileSync(target)}\nchanged after completed proof\n`);
    assertSameGit(f);
    assert.equal(execFileSync("git", ["-C", f.repo, "status", "--porcelain"], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }), "");
    const result = verify(f); assert.notEqual(result.status, 0); assert.match(result.stderr, /CURRENT_INPUT_INVENTORY_CHANGED/);
    return { status: result.status };
  });
  await case_("changed-restored-write-during-current-input-revalidation-refuses", async () => {
    const f = fixture("reuse-interference", "reuse-hold"); launch(f); assert.equal((await finish(f)).code, 0, f.output);
    const inventory = join(session(f), "inventory.json");
    const child = spawn(process.env.BULLET_CI_SOURCE_MONITOR_BIN, ["--verify-inventory", inventory], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    f.child = child; f.retired = false; let stderr = ""; child.stderr.on("data", (b) => { stderr += b; });
    const done = new Promise((resolve) => child.once("close", (code) => { f.retired = true; resolve(code); }));
    const target = join(f.repo, "node_modules/tool.js"); const inode = statSync(target).ino.toString(16);
    await until(() => {
      try { return readdirSync(`/proc/${child.pid}/fdinfo`).some((fd) => readFileSync(`/proc/${child.pid}/fdinfo/${fd}`, "utf8").includes(`ino:${inode} `)); }
      catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
    }, "live reuse watch installation");
    const digest = restored(target); assert.notEqual(await done, 0); assert.match(stderr, /SOURCE_MUTATION/);
    return { stderr, ending_sha256: digest };
  });
  for (const marker of ["refused", "invalidated"]) await case_(`completed-public-bytes-refuse-durable-${marker}`, async () => {
    const f = fixture(`durable-${marker}`); launch(f); assert.equal((await finish(f)).code, 0, f.output);
    const publicPath = join(f.repo, ".ci-artifacts/observations/fast.json"); const digest = hash(publicPath);
    if (marker === "refused") writeFileSync(join(session(f), "refused.json"), JSON.stringify({ schema: "bullet.source-proof.refusal.v1", message: "diagnostic interrupted publication" }), { mode: 0o600 });
    else {
      const id = json(join(f.repo, ".ci-artifacts/lifecycle/active/fast.json")).generation;
      const p = join(f.repo, ".ci-artifacts/lifecycle/generations", id);
      const pending = json(join(p, "pending.json"));
      const refusal = join(session(f), "refused.json");
      writeFileSync(refusal, JSON.stringify({ schema: "bullet.source-proof.refusal.v1", message: "diagnostic partial invalidation" }), { mode: 0o600 });
      writeFileSync(join(p, "invalidated.json"), JSON.stringify({ source_session: pending.source_custody.session, refusal_sha256: hash(refusal), pending_sha256: hash(join(p, "pending.json")), sealed_sha256: hash(join(p, "sealed.json")) }), { mode: 0o600 });
    }
    const result = verify(f); assert.notEqual(result.status, 0); assert.equal(hash(publicPath), digest);
    assert.match(result.stderr, /durably invalidated|SOURCE_PROOF_DURABLY_REFUSED|invalidation/); return { status: result.status };
  });
  await case_("pidfd-cleanup-never-signals-replaced-start-identity", async () => {
    const f = fixture("pidfd"); const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); f.child = child;
    const ticks = readFileSync(`/proc/${child.pid}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/)[19];
    const monitor = process.env.BULLET_CI_SOURCE_MONITOR_BIN;
    const wrong = JSON.parse(execFileSync(monitor, ["--terminate-monitor", String(child.pid), "0", String(process.pid)], { encoding: "utf8" }));
    assert.equal(wrong.outcome, "IDENTITY_CHANGED_NOT_SIGNALED"); process.kill(child.pid, 0);
    const correct = JSON.parse(execFileSync(monitor, ["--terminate-monitor", String(child.pid), ticks, String(process.pid)], { encoding: "utf8" }));
    assert.equal(correct.outcome, "TERMINATED"); f.retired = true; return { wrong, correct };
  });
  for (const flag of ["assume-unchanged", "skip-worktree"]) await case_(`pre-existing-${flag}-dirty-source-refuses-before-launch`, async () => {
    const f = fixture(`initial-${flag}`);
    execFileSync("git", ["-C", f.repo, "update-index", `--${flag}`, "input.rs"]);
    writeFileSync(join(f.repo, "input.rs"), "different executed bytes\n");
    launch(f); const result = await finish(f);
    assert.notEqual(result.code, 0); assert.match(result.output, /HIDDEN_INDEX_AUTHORITY_REFUSED/);
    assert.equal(existsSync(join(f.repo, ".ci-artifacts/reports/vitest.json")), false); return result;
  });
  await case_("pre-existing-ignored-executable-mode-refuses-before-launch", async () => {
    const f = fixture("initial-mode");
    execFileSync("git", ["-C", f.repo, "config", "core.filemode", "false"]);
    chmodSync(join(f.repo, "input.rs"), 0o755);
    launch(f); const result = await finish(f);
    assert.notEqual(result.code, 0); assert.match(result.output, /RAW_TRACKED_INPUT_DIFFERS_FROM_ADMITTED_TREE/);
    assert.equal(existsSync(join(f.repo, ".ci-artifacts/reports/vitest.json")), false); return result;
  });
  await case_("clean-filter-normalization-cannot-hide-different-raw-source", async () => {
    const f = fixture("initial-filter");
    execFileSync("git", ["-C", f.repo, "config", "core.autocrlf", "true"]);
    const source = join(f.repo, "input.rs"); writeFileSync(source, readFileSync(source, "utf8").replaceAll("\n", "\r\n"));
    execFileSync("git", ["-C", f.repo, "add", "--renormalize", "input.rs"]);
    assert.equal(execFileSync("git", ["-C", f.repo, "status", "--porcelain"], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }), "");
    launch(f); const result = await finish(f);
    assert.notEqual(result.code, 0); assert.match(result.output, /RAW_TRACKED_INPUT_DIFFERS_FROM_ADMITTED_TREE/);
    assert.equal(existsSync(join(f.repo, ".ci-artifacts/reports/vitest.json")), false); return result;
  });
  await case_("path-replacement-between-configuration-and-ready-refuses", async () => {
    const f = fixture("startup-path", "startup-path"); launch(f);
    const inode = statSync(join(f.repo, "input.rs")).ino.toString(16);
    await until(() => {
      const p = join(f.repo, ".ci-artifacts/source-proof");
      if (!existsSync(p)) return false;
      for (const id of readdirSync("/proc").filter((p) => /^[1-9]\d*$/.test(p))) {
        try {
          const fields = readFileSync(`/proc/${id}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/);
          if (Number(fields[1]) !== f.child.pid) continue;
          if (readdirSync(`/proc/${id}/fdinfo`).some((fd) => readFileSync(`/proc/${id}/fdinfo/${fd}`, "utf8").includes(`ino:${inode} `))) return true;
        } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
      }
      return false;
    }, "startup checkout watches before PATH root");
    const alias = join(f.admission.tool_path, "cat"); unlinkSync(alias); symlinkSync("/usr/bin/false", alias);
    const result = await finish(f); assert.notEqual(result.code, 0); assert.match(result.output, /TOOL_SELECTION_CHANGED|SOURCE_MUTATION/);
    assert.equal(existsSync(join(f.repo, ".ci-artifacts/reports/vitest.json")), false); return result;
  });
  await case_("deterministic-ready-rechecks-path-selected-before-watch-installation", async () => {
    const f = fixture("direct-ready");
    const ownerDirectory = join(f.repo, ".git/bullet-ci.lock.d"); mkdirSync(ownerDirectory, { mode: 0o700 });
    const owner = join(ownerDirectory, "owner"); writeFileSync(owner, "diagnostic component owner\n", { mode: 0o600 });
    const saved = { ...process.env }; const cwd = process.cwd(); let input; let output; let monitor; let exited;
    try {
      process.chdir(f.repo);
      Object.assign(process.env, f.env, { BULLET_CI_SOURCE_OWNER_PID: String(process.pid), BULLET_CI_SOURCE_ADMISSION: f.admission.path, BULLET_CI_SOURCE_ADMISSION_SHA256: f.admission.sha256 });
      const { configure } = await import(pathToFileURL(join(f.repo, "ops/ci/source-custody.mjs")).href);
      const [p, config, binary] = configure("fast", owner).split("\n");
      const alias = join(f.admission.tool_path, "cat"); unlinkSync(alias); symlinkSync("/usr/bin/false", alias);
      const fifoInput = `${f.repo}.source-admission/input-fifo`; const fifoOutput = `${f.repo}.source-admission/output-fifo`;
      execFileSync("/usr/bin/mkfifo", ["-m", "600", fifoInput, fifoOutput]);
      input = openSync(fifoInput, constants.O_RDWR); output = openSync(fifoOutput, constants.O_RDWR);
      monitor = spawn(binary, [config], { stdio: [input, output, "pipe"] }); f.child = monitor; f.retired = false;
      exited = new Promise((resolve, reject) => { monitor.once("error", reject); monitor.once("close", (code) => { f.retired = true; resolve(code); }); });
      const ticks = readFileSync(`/proc/${monitor.pid}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/)[19];
      const result = spawnSync(process.execPath, ["ops/ci/source-custody.mjs", "READY"], { cwd: f.repo,
        env: { ...process.env, BULLET_CI_SOURCE_SESSION: p, BULLET_CI_SOURCE_MONITOR_PID: String(monitor.pid), BULLET_CI_SOURCE_MONITOR_START: ticks, BULLET_CI_SOURCE_READ_FD: "3" },
        stdio: ["ignore", "pipe", "pipe", output], encoding: "utf8", timeout: 10_000 });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /TOOL_SELECTION_CHANGED: cat/);
      assert.equal(existsSync(join(p, "ack-00000000.json")), false);
      return { status: result.status, stderr: result.stderr, monitor_started_after_path_replacement: true };
    } finally {
      // Controlled invalid framing makes the real monitor exit without any
      // remembered-PID signal. It is reaped before descriptors are released.
      if (input !== undefined) writeFileSync(input, "{}\n");
      if (exited) assert.notEqual(await exited, 0);
      if (input !== undefined) closeSync(input); if (output !== undefined) closeSync(output);
      process.chdir(cwd);
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
} catch (error) { failed = true; throw error; }
finally {
  for (const f of fixtures) {
    if (f.child?.pid && !f.retired && f.child.exitCode === null && f.child.signalCode === null) {
      try { process.kill(-f.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    writeFileSync(join(f.repo, "fixture-diagnostic.txt"), f.output);
  }
  mkdirSync(join(origin, ".ci-artifacts/reports"), { recursive: true });
  writeFileSync(join(origin, ".ci-artifacts/reports/source-custody-tests.json"), `${JSON.stringify({ schema: "bullet.source-custody.tests.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", cases: observations,
    verifications: fixtures.filter((f) => f.verifications.length).map((f) => ({ fixture: f.name, attempts: f.verifications })) }, null, 2)}\n`);
  if (failed) console.error(`[ci] retained failed source-custody fixtures: ${fixtureRoot}`);
  else { rmSync(fixtureRoot, { recursive: true }); console.log(`[ci] source custody integration passed (${observations.length} cases)`); }
}
