// Disposable fault-injection custody. Production entrypoints remain unchanged.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { admit } from "./source-custody-fixture.mjs";

const fixtures = new Map();
const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const lanes = ["required", "fast", "lint", "contract", "security", "docs", "rendered", "coverage", "scheduled-hygiene", "portable", "family", "nightly", "audit", "packaged-farmd"];
const helper = "ops/ci/source-custody.mjs";
const producer = "ops/ci/observation.mjs";
const fail = (message) => { throw new Error(`CI_LIFECYCLE_FIXTURE: ${message}`); };
function good(result, label) {
  if (result.status !== 0) fail(`${label}: ${result.stderr}`);
  return result.stdout.trim();
}
export function fixtureEnvironment(repo) {
  if (!fixtures.has(repo)) {
    const admission = admit(repo, lanes, ["npm", "zip", "unzip", "mkfifo"], ["target"]);
    fixtures.set(repo, { env: { GIT_OPTIONAL_LOCKS: "0", PATH: admission.tool_path, BULLET_CI_SOURCE_ADMISSION: admission.path, BULLET_CI_SOURCE_ADMISSION_SHA256: admission.sha256 }, session: null });
  }
  return fixtures.get(repo).env;
}
function execute(repo, command, args, env = {}, descriptors = null) {
  return spawnSync(command, args, { cwd: repo, encoding: "utf8", timeout: 60000,
    env: { ...process.env, ...fixtureEnvironment(repo), ...env },
    ...(descriptors ? { stdio: ["ignore", "pipe", "pipe", ...descriptors] } : {}) });
}
function processStatus(pid) {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/);
  return { state: fields[0], exit: Number(fields[49]) };
}
function waitExit(session) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const status = processStatus(session.child.pid);
    if (status.state === "Z" || status.state === "X") {
      if (status.exit !== 0) fail(`monitor exited ${status.exit}`);
      session.finished = true;
      return;
    }
    sleep();
  }
  fail("monitor exit deadline");
}
function start(repo, owner) {
  fixtureEnvironment(repo);
  const fixture = fixtures.get(repo);
  if (fixture.session) return fixture.session;
  const env = { BULLET_CI_SOURCE_OWNER_PID: String(process.pid), BULLET_CI_OBSERVATION_OWNER: owner };
  const fields = good(execute(repo, process.execPath, [helper, "configure", "family", join(repo, ".git/bullet-ci.lock.d/owner")], env), "configure").split("\n");
  const [path, config, monitor, timeout] = fields;
  // Register every resource before the next operation can fail. Cleanup owns
  // even a half-open pipe pair or a child whose /proc identity cannot be read.
  const session = { child: null, closed: null, config, path, ownedFds: [], descriptors: [], finished: false, env: {} };
  fixture.session = session;
  const controls = join(repo, ".ci-artifacts/fixture-control"); mkdirSync(controls, { recursive: true });
  const input = join(controls, "input"); const output = join(controls, "output");
  good(execute(repo, "mkfifo", ["-m", "600", input, output]), "FIFO creation");
  const inputFd = openSync(input, "r+"); session.ownedFds.push(inputFd);
  const outputFd = openSync(output, "r+"); session.ownedFds.push(outputFd);
  const errorFd = openSync(join(path, "monitor.stderr"), "wx", 0o600); session.ownedFds.push(errorFd);
  const child = spawn(monitor, [config], { cwd: repo, env: { ...process.env, ...fixture.env }, stdio: [inputFd, outputFd, errorFd] });
  session.child = child;
  session.closed = new Promise((done) => {
    child.once("error", (error) => done({ error: error.message }));
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  closeSync(errorFd); session.ownedFds.pop();
  session.descriptors = [outputFd, inputFd];
  session.env = { ...env, BULLET_CI_SOURCE_SESSION: path, BULLET_CI_SOURCE_MONITOR_PID: String(child.pid),
    BULLET_CI_SOURCE_MONITOR_START: readFileSync(`/proc/${child.pid}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/)[19],
    BULLET_CI_SOURCE_READ_FD: "3", BULLET_CI_SOURCE_WRITE_FD: "4", BULLET_CI_SOURCE_RESPONSE_SECONDS: timeout };
  good(execute(repo, process.execPath, [helper, "READY"], session.env, session.descriptors), "READY");
  return session;
}
export function operation(repo, owner, ...args) {
  const session = start(repo, owner);
  return execute(repo, process.execPath, [producer, ...args], session.env, session.descriptors);
}
export function customOperation(repo, owner, command, args, env = {}) {
  const session = start(repo, owner);
  return execute(repo, command, args, { ...session.env, ...env }, session.descriptors);
}
export function finish(repo, childCode = 0, nodeArguments = []) {
  const session = fixtures.get(repo)?.session;
  if (!session) fail("missing live session");
  good(execute(repo, process.execPath, [producer, "readback"], session.env, session.descriptors), "readback");
  good(execute(repo, process.execPath, [helper, "FINISH"], session.env, session.descriptors), "FINISH");
  waitExit(session);
  return execute(repo, process.execPath, [...nodeArguments, producer, "publish", String(childCode), "0"], session.env);
}
export async function releaseSession(repo, retain = false) {
  const fixture = fixtures.get(repo); const session = fixture?.session;
  if (!session) return;
  if (session.child) {
    if (!session.finished) session.child.kill("SIGKILL"); // Owned Child handle, never a remembered process group.
    let timeout;
    try {
      await Promise.race([session.closed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("CI_LIFECYCLE_FIXTURE: child termination unknown; preserve fixture")), 30000);
      })]);
    } finally { clearTimeout(timeout); }
  }
  for (const fd of session.ownedFds) closeSync(fd);
  if (!retain && existsSync(session.config)) rmSync(session.config);
  if (!retain) rmSync(join(repo, ".ci-artifacts/fixture-control"), { recursive: true, force: true });
  fixture.session = null;
}
export async function cleanupFixture(repo, retain = false) {
  await releaseSession(repo, retain);
  fixtures.delete(repo);
  if (!retain) rmSync(`${repo}.source-admission`, { recursive: true, force: true });
}
