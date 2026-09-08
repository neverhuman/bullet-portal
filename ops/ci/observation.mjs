import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const fast = ["reports/farmd-test-proxy-override.log", "reports/vite-api-override.log", "reports/vitest.json"];
const policies = {
  fast, lint: [], contract: ["playwright/.last-run.json", "reports/playwright.xml"],
  security: [], docs: [], "scheduled-hygiene": [],
  coverage: ["coverage/coverage-summary.json", "reports/coverage-tests.json"],
  portable: ["platform/refusal.json", ...fast],
};
const root = ".ci-artifacts";
const state = `${root}/lifecycle`;
const generations = `${state}/generations`;
const active = (lane) => `${state}/active/${lane}.json`;
const observation = (lane) => `${root}/observations/${lane}.json`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message) => { throw new Error(`CI_OBSERVATION_LIFECYCLE: ${message}`); };
const [operation, ...args] = process.argv.slice(2);
if (operation === "prepare") {
  if (args.length !== 1) fail("prepare arguments");
  console.log(prepare(args[0]));
} else if (operation === "seal") {
  const [lane, generation, outcome, code, ...commands] = args;
  seal(lane, generation, outcome, code, commands);
} else {
  const [outcome, code, ...commands] = args;
  verify(operation, outcome, code, commands);
}

function lanePolicy(lane) {
  if (!Object.hasOwn(policies, lane)) fail(`unsupported lane ${lane}`);
  return policies[lane].map((path) => `${root}/${path}`);
}

// Every component is inspected without following links, including absent leaves.
function inspect(path, kind, optional = false) {
  if (path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === "..")) fail("unsafe path");
  const parts = path.split("/");
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === "ENOENT" && optional) return false;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : kind === "file" ? !stat.isFile() : !stat.isDirectory())) fail(`invalid ${kind}: ${current}`);
  }
  return true;
}

function directory(path) {
  if (inspect(path, "directory", true)) return;
  if (dirname(path) !== ".") directory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
}

function bytes(path) {
  inspect(path, "file");
  return readFileSync(path);
}

function json(path) { return JSON.parse(bytes(path)); }
function persist(path, value) {
  directory(dirname(path));
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
function record(path, value) { persist(path, `${JSON.stringify(value, null, 2)}\n`); }
function snapshot(source, destination) {
  const content = bytes(source);
  persist(destination, content);
  return hash(content);
}

function run(command, arguments_) {
  return execFileSync(command, arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function subject() {
  const source = {
    commit_oid: run("git", ["rev-parse", "HEAD"]),
    tree_oid: run("git", ["rev-parse", "HEAD^{tree}"]),
    clean: run("git", ["status", "--porcelain", "--untracked-files=normal"]) === "",
  };
  if (!source.clean || !/^[0-9a-f]{40,64}$/.test(source.commit_oid) || !/^[0-9a-f]{40,64}$/.test(source.tree_oid)) fail("clean source required");
  return source;
}

function custody(lane) {
  inspect(".git", "directory");
  inspect(".git/HEAD", "file");
  const ownerPath = ".git/bullet-ci.lock.d/owner";
  const owner = process.env.BULLET_CI_OBSERVATION_OWNER;
  const match = owner?.match(/^schema=2 repository=bullet-portal scope=(standalone|family) pid=([1-9][0-9]*) lane=([a-z0-9-]+) nonce=[0-9]+-[0-9]+-[0-9]+-[0-9]+$/);
  if (!match || bytes(ownerPath).toString() !== `${owner}\n`) fail("unverified custody");
  for (const [path, mode] of [[dirname(ownerPath), 0o700], [ownerPath, 0o600]]) {
    const stat = lstatSync(path);
    if ((stat.mode & 0o777) !== mode || (process.getuid && stat.uid !== process.getuid())) fail("custody mode/owner");
  }
  if (match[1] === "family" ? !["family", "family-contract"].includes(match[3]) : ![lane, "required", "gates", "all"].includes(match[3])) fail("custody lane");
  return owner;
}

function generationRoot(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? "")) fail("generation identity");
  const path = `${generations}/${id}`;
  inspect(path, "directory");
  return path;
}
function complete(id) {
  const path = generationRoot(id);
  const completion = json(`${path}/completion.json`);
  const pending = json(`${path}/pending.json`);
  const publication = json(`${path}/publication.json`);
  if (publication.completion_sha256 !== hash(bytes(`${path}/completion.json`)) || publication.observation_sha256 !== completion.observation_sha256) fail("publication binding");
  if (completion.generation !== id || completion.lane !== pending.lane || completion.prepared_sha256 !== hash(bytes(`${path}/prepared.json`)) || completion.observation_sha256 !== hash(bytes(`${path}/observation.json`))) fail("completion binding");
  const report = json(`${path}/observation.json`);
  const prepared = json(`${path}/prepared.json`);
  if (prepared.pending_sha256 !== hash(bytes(`${path}/pending.json`))) fail("pending binding");
  validateRetained(path, prepared);
  if (!equal(report.artifact_hashes, completion.artifact_hashes)) fail("completion inventory");
  for (const artifact of completion.artifact_hashes) {
    if (!validArtifact(artifact.path) || hash(bytes(`${path}/payload/${artifact.path}`)) !== artifact.sha256) fail("retained payload changed");
  }
  return { path, pending, report, completion };
}
function validateRetained(path, prepared) {
  for (const artifact of prepared.retained_working) {
    if (!validArtifact(artifact.path) || hash(bytes(`${path}/prior/working/${artifact.path}`)) !== artifact.sha256) fail("prior working payload changed");
  }
  for (const retired of prepared.retired) {
    lanePolicy(retired.lane);
    if (hash(bytes(`${path}/prior/observations/${retired.lane}.json`)) !== retired.observation_sha256) fail("retired observation changed");
    for (const reference of retired.references) {
      if (!validArtifact(reference.path)) fail("retired reference path");
      if (reference.retained_sha256 !== null && hash(bytes(`${path}/prior/references/${retired.lane}/${reference.path}`)) !== reference.retained_sha256) fail("retired reference changed");
    }
  }
}
function histories(except) {
  if (!inspect(generations, "directory", true)) return;
  for (const entry of readdirSync(generations)) {
    if (entry !== except) complete(entry); // Missing completion includes interrupted preparation/sealing.
  }
}
function validArtifact(path) {
  return typeof path === "string" && path.startsWith(`${root}/`) && path.length <= 1024 && path.normalize("NFC") === path && !/[\\\0]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== "..") && !path.startsWith(`${state}/`);
}
function trace(path) {
  return /^\.ci-artifacts\/playwright\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/trace\.zip$/.test(path) && validArtifact(path);
}
function files(path) {
  if (!inspect(path, "directory", true)) return [];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) fail(`symlink diagnostic ${child}`);
    if (stat.isDirectory()) return files(child);
    inspect(child, "file");
    return [child];
  });
}

function prepare(lane) {
  const selected = lanePolicy(lane);
  const owner = custody(lane);
  const source = subject();
  histories();
  directory(generations);
  const id = randomUUID();
  const path = `${generations}/${id}`;
  mkdirSync(path, { mode: 0o700 }); // Exclusive collision refusal; never reuse a generation.
  record(`${path}/pending.json`, { generation: id, lane, owner, source });
  const overlapping = Object.keys(policies).filter((other) => other === lane || lanePolicy(other).some((p) => selected.includes(p)));
  const retired = [];
  for (const other of overlapping) {
    if (inspect(active(other), "file", true)) {
      const previous = json(active(other));
      const retained = complete(previous.generation);
      if (retained.pending.lane !== other) fail("active lane mismatch");
      directory(`${path}/prior/active`);
      renameSync(active(other), `${path}/prior/active/${other}.json`);
    }
    if (inspect(observation(other), "file", true)) {
      const previous = json(observation(other));
      const references = [];
      for (const artifact of previous.artifact_hashes ?? []) {
        if (!validArtifact(artifact.path)) fail("legacy reference path");
        const present = inspect(artifact.path, "file", true);
        const digest = present ? snapshot(artifact.path, `${path}/prior/references/${other}/${artifact.path}`) : null;
        references.push({ path: artifact.path, recorded_sha256: artifact.sha256, retained_sha256: digest, disposition: !present ? "MISSING_LEGACY_REFERENCE" : digest === artifact.sha256 ? "RETAINED" : "CHANGED_LEGACY_REFERENCE" });
      }
      directory(`${path}/prior/observations`);
      renameSync(observation(other), `${path}/prior/observations/${other}.json`);
      retired.push({ lane: other, observation_sha256: hash(bytes(`${path}/prior/observations/${other}.json`)), references });
    }
  }
  const owned = new Set(overlapping.flatMap(lanePolicy));
  const retainedWorking = [];
  const retainHash = (artifact) => {
    if (!validArtifact(artifact)) fail("prior working path");
    retainedWorking.push({ path: artifact, sha256: hash(bytes(artifact)) });
  };
  if (lane === "contract") {
    owned.delete(`${root}/playwright/.last-run.json`);
    if (inspect(`${root}/playwright`, "directory", true)) {
      files(`${root}/playwright`).forEach(retainHash);
      directory(`${path}/prior/working/${root}`);
      renameSync(`${root}/playwright`, `${path}/prior/working/${root}/playwright`);
    }
  }
  for (const artifact of owned) {
    if (!inspect(artifact, "file", true)) continue;
    retainHash(artifact);
    directory(dirname(`${path}/prior/working/${artifact}`));
    renameSync(artifact, `${path}/prior/working/${artifact}`);
  }
  for (const artifact of selected) if (inspect(artifact, "file", true)) fail("output not absent");
  if (!equal(subject(), source) || custody(lane) !== owner) fail("preparation subject/custody drift");
  record(`${path}/prepared.json`, { pending_sha256: hash(bytes(`${path}/pending.json`)), absent: selected, retained_working: retainedWorking, retired });
  record(active(lane), { generation: id });
  return id;
}

function argumentsFor(lane, outcome, codeText, commands) {
  lanePolicy(lane);
  const code = Number(codeText);
  if (!/^(success|failure|cancelled|skipped)$/.test(outcome ?? "") || !/^(0|[1-9][0-9]*)$/.test(codeText ?? "") || code > 255 || (outcome === "success") !== (code === 0)) fail("outcome arguments");
  return { outcome, code, commands: commands.length ? commands : ["cancelled", "skipped"].includes(outcome) ? [] : [`bash scripts/ci-local.sh ${lane}`] };
}
function tools() {
  const version = (command, args) => { try { return run(command, args); } catch { return "unavailable"; } };
  return {
    node: process.version, npm: version("npm", ["--version"]),
    actionlint: version("actionlint", ["-version"]).split("\n", 1)[0],
    shellcheck: version("shellcheck", ["--version"]).match(/version: ([^\n]+)/)?.[1] ?? "unavailable",
    gitleaks: version("gitleaks", ["version"]), zizmor: version("zizmor", ["--version"]),
  };
}
function seal(lane, id, outcome, codeText, commands) {
  const invocation = argumentsFor(lane, outcome, codeText, commands);
  if (!["success", "failure"].includes(outcome) || !equal(invocation.commands, [`bash scripts/ci-local.sh ${lane}`])) fail("unexecuted outcome/command");
  const owner = custody(lane);
  const path = generationRoot(id);
  histories(id);
  const pending = json(`${path}/pending.json`);
  const prepared = json(`${path}/prepared.json`);
  if (pending.generation !== id || pending.lane !== lane || pending.owner !== owner || prepared.pending_sha256 !== hash(bytes(`${path}/pending.json`)) || !equal(prepared.absent, lanePolicy(lane)) || !equal(subject(), pending.source) || json(active(lane)).generation !== id) fail("preparation changed");
  if (inspect(`${path}/completion.json`, "file", true)) fail("generation already sealed");
  const paths = lanePolicy(lane).filter((artifact) => inspect(artifact, "file", outcome !== "success"));
  if (lane === "contract" && outcome === "failure") paths.push(...files(`${root}/playwright`).filter(trace));
  const artifacts = [...new Set(paths)].sort().map((artifact) => ({ path: artifact, sha256: snapshot(artifact, `${path}/payload/${artifact}`) }));
  const report = {
    schema_version: "bullet.ci-observation.v1", repository: "bullet-portal", ...pending.source,
    commands: invocation.commands, tool_versions: tools(),
    outcomes: [{ lane, status: outcome === "success" ? "PASS" : "FAIL", exit_code: invocation.code }],
    artifact_hashes: artifacts, signed: false, evidence_class: "DIAGNOSTIC_ONLY",
  };
  if (!equal(subject(), pending.source) || custody(lane) !== owner) fail("sealing subject/custody drift");
  for (const artifact of artifacts) if (hash(bytes(artifact.path)) !== artifact.sha256) fail("output changed while sealing");
  validateRetained(path, prepared);
  record(`${path}/observation.json`, report);
  if (inspect(observation(lane), "file", true)) fail("active observation collision");
  directory(dirname(observation(lane)));
  snapshot(`${path}/observation.json`, `${path}/publish.json`);
  record(`${path}/completion.json`, { generation: id, lane, outcome, prepared_sha256: hash(bytes(`${path}/prepared.json`)), observation_sha256: hash(bytes(`${path}/observation.json`)), artifact_hashes: artifacts });
  renameSync(`${path}/publish.json`, observation(lane));
  // Completion is not admitted until publication has its own immutable receipt.
  record(`${path}/publication.json`, { completion_sha256: hash(bytes(`${path}/completion.json`)), observation_sha256: hash(bytes(observation(lane))) });
}
function verify(lane, outcome, codeText, commands) {
  const invocation = argumentsFor(lane, outcome, codeText, commands);
  histories();
  const { pending, report, completion } = complete(json(active(lane)).generation);
  if (completion.outcome !== invocation.outcome || pending.lane !== lane || !equal(subject(), pending.source) || !equal(report.commands, invocation.commands) || !equal(report.outcomes, [{ lane, status: outcome === "success" ? "PASS" : "FAIL", exit_code: invocation.code }]) || hash(bytes(observation(lane))) !== completion.observation_sha256) fail("sealed invocation mismatch");
  for (const artifact of report.artifact_hashes) if (hash(bytes(artifact.path)) !== artifact.sha256) fail("sealed output changed");
  console.log(`[ci] verified unsigned sealed observation ${observation(lane)}`);
}
