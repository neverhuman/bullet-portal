// One-shot framing/admission adapter for the existing Bash proof owner.
// Rust is the live monitor. This module never starts a server or grants custody.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync, constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, readlinkSync, realpathSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lookupInputs, monitorSources, validatePolicyAdmission } from "./source-policy.mjs";
import { bootstrap } from "./source-bootstrap.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha = /^[a-f0-9]{64}$/;
const fail = (message, cause) => {
  const error = new Error(`CI_SOURCE_CUSTODY: ${message}`, cause ? { cause } : undefined);
  error.code = "CI_SOURCE_CUSTODY"; throw error;
};
export function custodyFailureExit(error) {
  if (error.code !== "CI_SOURCE_CUSTODY") throw error;
  console.error(error); process.exitCode = 75;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (path, root) => path === root || path.startsWith(`${root}/`);
const root = process.cwd();

function path(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value)) fail("absolute normalized path required");
  return value;
}
function regular(value) {
  path(value);
  let cursor = value;
  while (cursor !== dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) fail(`symlink custody path: ${cursor}`);
    cursor = dirname(cursor);
  }
  const stat = lstatSync(value);
  if (!stat.isFile()) fail(`regular input required: ${value}`);
  return value;
}
function bytes(value) { return readFileSync(regular(value)); }
function json(value) { return JSON.parse(bytes(value)); }
function binding(value) {
  if (!value || !sha.test(value.sha256 ?? "") || hash(bytes(value.path)) !== value.sha256) fail("input hash binding");
  return value.path;
}
function record(value, body) {
  const fd = openSync(value, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(body)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(value) {
  if (value !== dirname(value)) directory(dirname(value));
  try { mkdirSync(value, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("output directory custody");
}
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function start(pid) {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/);
  if (["Z", "X"].includes(fields[0]) || !/^\d+$/.test(fields[19] ?? "")) fail("process identity unavailable");
  return fields[19];
}
function selectedTool(tool) {
  binding(tool);
  const selected = process.env.PATH.split(":").map((p) => join(p, tool.name)).find((p) => {
    try { accessSync(p, constants.X_OK); return lstatSync(p).isFile() || lstatSync(p).isSymbolicLink(); }
    catch { return false; }
  });
  if (!selected || realpathSync(selected) !== tool.path) fail(`TOOL_SELECTION_CHANGED: ${tool.name}`);
}
function committedInputs() {
  // Git's normal status trusts index flags and clean filters. Neither can stand
  // in for the raw executable worktree bytes that this proof will consume.
  for (const flag of ["-v", "-f"]) {
    if (git("ls-files", flag, "-z").split("\0").filter(Boolean).some((p) => !p.startsWith("H "))) fail("HIDDEN_INDEX_AUTHORITY_REFUSED");
  }
  const format = git("rev-parse", "--show-object-format");
  if (!["sha1", "sha256"].includes(format)) fail("GIT_OBJECT_FORMAT_UNSUPPORTED");
  const entries = git("ls-tree", "-r", "-z", "HEAD").split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^([0-9]{6}) blob ([0-9a-f]+)\t(.+)$/);
    if (!match || /[\x00-\x1f\x7f]/.test(match[3]) || !["100644", "100755", "120000"].includes(match[1])) fail("TRACKED_INPUT_KIND_UNSUPPORTED");
    return { mode: match[1], oid: match[2], path: match[3] };
  });
  const index = git("ls-files", "--stage", "-z").split("\0").filter(Boolean).sort();
  if (!same(index, entries.map((e) => `${e.mode} ${e.oid} 0\t${e.path}`).sort())) fail("INDEX_DIFFERS_FROM_ADMITTED_TREE");
  for (const entry of entries) {
    const input = join(root, entry.path); const metadata = lstatSync(input);
    const mode = metadata.isSymbolicLink() ? "120000" : metadata.isFile() ? metadata.mode & 0o100 ? "100755" : "100644" : "unsupported";
    if (mode === "unsupported") fail("TRACKED_INPUT_KIND_UNSUPPORTED");
    const content = metadata.isSymbolicLink() ? readlinkSync(input, { encoding: "buffer" }) : readFileSync(input);
    const oid = createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
    if (mode !== entry.mode || oid !== entry.oid) fail("RAW_TRACKED_INPUT_DIFFERS_FROM_ADMITTED_TREE");
  }
}
function revalidateAdmission(selected) {
  binding({ path: selected.admission_path, sha256: selected.admission_sha256 });
  const admission = json(selected.admission_path);
  const build = json(binding(admission.monitor.build));
  const release = json(binding(admission.writer_release));
  [admission.monitor, admission.review, ...build.sources, ...build.tools, ...admission.tools,
    ...(release.writers ?? []).flatMap((writer) => [writer.grant, writer.release])].forEach(binding);
  if (json(admission.review.path).schema === "bullet.source-policy-evaluation.v1") validatePolicyAdmission(admission, root);
  admission.tools.forEach(selectedTool);
  if (git("rev-parse", "HEAD") !== selected.source.commit_oid || git("rev-parse", "HEAD^{tree}") !== selected.source.tree_oid) fail("SOURCE_CHANGED_BEFORE_READY");
  committedInputs();
}

export function configure(lane, ownerRecord) {
  if (process.platform !== "linux") fail("SOURCE_MONITOR_UNAVAILABLE: Linux required");
  const admissionPath = process.env.BULLET_CI_SOURCE_ADMISSION;
  const admittedHash = process.env.BULLET_CI_SOURCE_ADMISSION_SHA256;
  if (!admissionPath || !sha.test(admittedHash ?? "") || hash(bytes(admissionPath)) !== admittedHash) fail("SOURCE_ADMISSION_REQUIRED");
  const admission = json(admissionPath);
  const expiry = Date.parse(admission.expires_at);
  if (admission.schema !== "bullet.source-admission.v1" || admission.repository !== "bullet-portal"
      || admission.checkout !== root || realpathSync(root) !== root || !admission.lanes?.includes(lane)
      || admission.path !== process.env.PATH || !Number.isFinite(expiry) || expiry <= Date.now()
      || !Number.isSafeInteger(admission.max_seconds) || admission.max_seconds < 1 || admission.max_seconds > 86400
      || expiry < Date.now() + admission.max_seconds * 1000
      || !Number.isSafeInteger(admission.response_seconds) || admission.response_seconds < 1 || admission.response_seconds > 60
      || !same(admission.conditions, { cooperative_freeze: true, local_filesystem: true, no_mmap_writers: true, no_mount_changes: true })
      || admission.inputs_complete !== true || admission.tools_complete !== true) fail("SOURCE_ADMISSION_INVALID_OR_EXPIRED");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  if (admission.source?.commit_oid !== commit || admission.source?.tree_oid !== tree) fail("SOURCE_ADMISSION_STALE");
  if (git("status", "--porcelain", "--untracked-files=normal") !== "") fail("clean source required");
  committedInputs();
  for (const variable of ["BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"]) {
    if (process.env[variable]) fail(`unadmitted executable environment: ${variable}`);
  }
  const monitor = binding(admission.monitor);
  const buildPath = binding(admission.monitor.build);
  const build = json(buildPath);
  if (build.schema !== "bullet.source-monitor.build.v1" || build.executable_sha256 !== admission.monitor.sha256) fail("MONITOR_BUILD_BINDING");
  const automated = json(binding(admission.review)).schema === "bullet.source-policy-evaluation.v1";
  const sourceRoot = automated ? path(build.source_root) : join(root, "ops/proof/source-monitor");
  const requiredSources = monitorSources.map((p) => join(sourceRoot, p));
  if (!Array.isArray(build.sources) || !same(build.sources.map((s) => s.path).sort(), requiredSources.sort())) fail("MONITOR_SOURCE_INVENTORY");
  const mandatory = [admissionPath, binding(admission.writer_release), binding(admission.review), monitor, buildPath, ...build.sources.map(binding)];
  const { review: reviewReference, ...reviewedAdmission } = admission;
  const review = json(reviewReference.path);
  const policyEvaluation = review.schema === "bullet.source-policy-evaluation.v1";
  if (policyEvaluation) mandatory.push(...validatePolicyAdmission(admission, root));
  else if (review.schema !== "bullet.source-admission-review.v1" || review.verdict !== "accepted"
      || typeof admission.author !== "string" || !admission.author || typeof review.reviewer !== "string" || !review.reviewer
      || review.reviewer === admission.author || review.admission_subject_sha256 !== hash(Buffer.from(JSON.stringify(reviewedAdmission)))) fail("EXACT_INDEPENDENT_ADMISSION_REVIEW_REQUIRED");
  const release = json(admission.writer_release.path);
  if (!policyEvaluation && (release.schema !== "bullet.source-writer-release.v1" || release.checkout !== root
      || !same(release.source, admission.source) || release.all_potential_writers_listed !== true
      || !Array.isArray(release.writers) || release.writers.length === 0)) fail("WRITER_RELEASE_REQUIRED");
  const writers = new Set();
  for (const writer of release.writers ?? []) {
    if (typeof writer.identity !== "string" || !writer.identity || writers.has(writer.identity)
        || !["released", "suspended"].includes(writer.state)) fail("WRITER_RELEASE_INCOMPLETE");
    writers.add(writer.identity);
    mandatory.push(binding(writer.grant), binding(writer.release));
  }
  if (!Array.isArray(admission.input_roots) || admission.input_roots.length === 0 || !Array.isArray(admission.tools)) fail("INPUT_TOOL_ROOTS_REQUIRED");
  const tools = new Map();
  for (const tool of admission.tools) {
    if (!/^[a-z0-9][a-z0-9._+-]*$/.test(tool.name ?? "") || tools.has(tool.name)) fail("TOOL_IDENTITY");
    selectedTool(tool);
    tools.set(tool.name, tool); mandatory.push(tool.path);
  }
  for (const name of ["bash", "node", "git", "timeout", "stat", "wc", "mkdir", "rm", "rmdir", "uname", "dirname", "sleep"]) {
    if (!tools.has(name)) fail(`CONTROL_TOOL_NOT_ADMITTED: ${name}`);
  }
  if (!Array.isArray(build.tools) || !["rustc", "cargo"].every((name) => build.tools.some((t) => t.name === name))) fail("BUILD_TOOL_SUBJECTS_REQUIRED");
  mandatory.push(...build.tools.map(binding));
  const inputs = [...new Set([root, ...admission.input_roots.map(path), ...mandatory])].sort();
  for (const input of inputs) if (realpathSync(input) !== input) fail("canonical input root required");
  for (const directory of process.env.PATH.split(":")) {
    path(directory);
    if (!admission.input_roots.some((input) => inside(directory, input))) fail("PATH_DIRECTORY_NOT_WATCHED");
  }
  if (!Array.isArray(admission.outputs) || admission.outputs.length === 0) fail("EXPLICIT_OUTPUT_SUBTREES_REQUIRED");
  const outputs = admission.outputs.map((output) => {
    path(output.path);
    if (!inside(output.path, root) || output.path === root || inside(output.path, join(root, ".git"))
        || typeof output.reason !== "string" || !output.reason.trim()
        || mandatory.some((input) => inside(input, output.path))
        || admission.input_roots.some((input) => inside(input, output.path))) fail("UNSAFE_OUTPUT_EXCLUSION");
    if (git("ls-files", "--", relative(root, output.path)) !== "") fail("TRACKED_INPUT_EXCLUDED");
    return output.path;
  });
  if (!outputs.includes(join(root, ".ci-artifacts"))) fail("ARTIFACT_OUTPUT_NOT_ADMITTED");
  const lookups = lookupInputs(admission.lookups);
  if (lookups.some((lookup) => outputs.some((output) => inside(lookup.path, output) || (lookup.target !== null && inside(lookup.target, output))))) fail("LOOKUP_INTERSECTS_EXCLUDED_OUTPUT");
  const id = randomUUID();
  const session = join(root, ".ci-artifacts/source-proof", id);
  directory(session);
  const configPath = join(dirname(ownerRecord), `source-monitor-${id}.json`);
  const config = { schema: "bullet.source-monitor.config.v1", nonce: randomBytes(32).toString("hex"),
    owner_pid: Number(process.env.BULLET_CI_SOURCE_OWNER_PID), owner_record: ownerRecord,
    roots: inputs, ...(lookups.length ? { lookups } : {}), exclude: outputs, inventory_path: join(session, "inventory.json"), max_seconds: admission.max_seconds };
  if (!Number.isSafeInteger(config.owner_pid) || config.owner_pid < 1) fail("WRAPPER_OWNER_IDENTITY");
  record(configPath, config);
  record(join(session, "start.json"), { schema: "bullet.source-proof.start.v1", session: id, config_path: configPath,
    config_sha256: hash(bytes(configPath)), admission_path: admissionPath, admission_sha256: admittedHash,
    writer_release_sha256: admission.writer_release.sha256, review_sha256: admission.review.sha256,
    source: admission.source, monitor_path: monitor, monitor_sha256: admission.monitor.sha256,
    owner_start: start(config.owner_pid), response_seconds: admission.response_seconds,
    environment_sha256: hash(Buffer.from(JSON.stringify(Object.entries(process.env).sort()))) });
  return [session, configPath, monitor, String(admission.response_seconds)].join("\n");
}

function sessionPath() {
  const value = process.env.BULLET_CI_SOURCE_SESSION;
  if (!value || dirname(value) !== join(root, ".ci-artifacts/source-proof") || !/^[a-f0-9-]{36}$/.test(value.split("/").at(-1))) fail("SOURCE_SESSION_REQUIRED");
  return value;
}
function acks(session) {
  return readdirSync(session).filter((p) => /^ack-[0-9]{8}\.json$/.test(p)).sort().map((p) => json(join(session, p)));
}
function readAck() {
  const input = Number(process.env.BULLET_CI_SOURCE_READ_FD);
  if (!Number.isSafeInteger(input) || input < 3) fail("MONITOR_CONTROL_FD_REQUIRED");
  const byte = Buffer.alloc(1); const result = [];
  while (result.length < 8192) {
    if (readSync(input, byte, 0, 1, null) !== 1) fail("MONITOR_CONTROL_EOF");
    if (byte[0] === 10) return JSON.parse(Buffer.from(result).toString("utf8"));
    result.push(byte[0]);
  }
  fail("MONITOR_ACK_TOO_LARGE");
}
function ackKeys(ack) {
  return same(Object.keys(ack).sort(), ["schema", "command", "nonce", "subject", "sequence", "monitor_pid", "monitor_start", "owner_pid", "owner_start", "watch_sha256", "entry_count"].sort());
}
function validateAck(ack, previous, command, config, selected) {
  if (!ackKeys(ack) || ack.schema !== "bullet.source-monitor.ack.v1" || ack.command !== command
      || ack.nonce !== config.nonce || ack.owner_pid !== config.owner_pid || ack.owner_start !== selected.owner_start
      || ack.monitor_pid !== Number(process.env.BULLET_CI_SOURCE_MONITOR_PID)
      || ack.monitor_start !== process.env.BULLET_CI_SOURCE_MONITOR_START
      || !/^\d+$/.test(ack.monitor_start ?? "") || !sha.test(ack.subject ?? "") || !sha.test(ack.watch_sha256 ?? "")
      || !Number.isSafeInteger(ack.entry_count) || ack.entry_count < 1
      || ack.sequence !== (previous ? previous.sequence + 1 : 0)) fail("MONITOR_ACK_IDENTITY");
  if (previous && !same({ ...previous, command: ack.command, sequence: ack.sequence }, ack)) fail("MONITOR_ACK_SUBJECT_CHANGED");
}
export function exchange(command) {
  try { return exchangeControl(command); }
  catch (error) {
    if (error.code === "CI_SOURCE_CUSTODY") throw error;
    fail(`MONITOR_CONTROL_FAILURE: ${error.code ?? error.name}: ${error.message}`, error);
  }
}
function exchangeControl(command) {
  const session = sessionPath();
  const selected = json(join(session, "start.json")); const config = json(selected.config_path);
  if (hash(bytes(selected.config_path)) !== selected.config_sha256 || start(config.owner_pid) !== selected.owner_start) fail("MONITOR_OWNER_CHANGED");
  const history = acks(session); const previous = history.at(-1);
  if (command === "READY" ? history.length !== 0 : !previous || previous.command === "FINISHED") fail("MONITOR_PROTOCOL_ORDER");
  if (command !== "READY") {
    const output = Number(process.env.BULLET_CI_SOURCE_WRITE_FD);
    if (!Number.isSafeInteger(output) || output < 3) fail("MONITOR_CONTROL_FD_REQUIRED");
    const request = Buffer.from(`${JSON.stringify({ command, nonce: config.nonce, subject: previous.subject, sequence: previous.sequence + 1 })}\n`);
    if (writeSync(output, request) !== request.length) fail("MONITOR_CONTROL_SHORT_WRITE");
  }
  const ack = readAck();
  validateAck(ack, previous, command === "CHECK" ? "CHECKED" : command === "FINISH" ? "FINISHED" : "READY", config, selected);
  if (command === "READY") {
    if (ack.monitor_start !== start(ack.monitor_pid) || ack.subject !== hash(bytes(config.inventory_path))) fail("MONITOR_READY_SUBJECT");
    const inventory = json(config.inventory_path);
    if (!same(inventory.config, config) || inventory.schema !== "bullet.source-monitor.inventory.v1") fail("MONITOR_INVENTORY_CONFIG");
    revalidateAdmission(selected); // Watch installation precedes this final input admission.
  }
  record(join(session, `ack-${String(ack.sequence).padStart(8, "0")}.json`), ack);
  return ack;
}
export function checkpoint() { return exchange("CHECK"); }
export function currentBinding() {
  const session = sessionPath(); const selected = json(join(session, "start.json")); const ready = json(join(session, "ack-00000000.json"));
  return { session: selected.session, start_sha256: hash(bytes(join(session, "start.json"))), inventory_sha256: ready.subject,
    ready_sha256: hash(bytes(join(session, "ack-00000000.json"))), admission_sha256: selected.admission_sha256 };
}
export function finishRecord(childCode, monitorCode, stages) {
  const session = sessionPath(); const history = acks(session); const last = history.at(-1);
  if (monitorCode !== 0 || !last || last.command !== "FINISHED" || !Number.isSafeInteger(childCode) || childCode < 0 || childCode > 255) fail("MONITOR_FINISH_NOT_OBSERVED");
  const selected = json(join(session, "start.json"));
  for (const [i, ack] of history.entries()) {
    if (ack.sequence !== i || !same({ ...history[0], command: ack.command, sequence: i }, ack)) fail("MONITOR_ACK_HISTORY_CHANGED");
  }
  const proof = { schema: "bullet.source-proof.v1", binding: currentBinding(), source: selected.source,
    monitor_sha256: selected.monitor_sha256, writer_release_sha256: selected.writer_release_sha256,
    review_sha256: selected.review_sha256, monitor_exit: monitorCode, proof_child_exit: childCode,
    acknowledgements: history, stages };
  record(join(session, "complete.json"), proof);
  return proof;
}
export function completedProof(binding_, revalidate = false) {
  const session = join(root, ".ci-artifacts/source-proof", binding_.session);
  if (!/^[a-f0-9-]{36}$/.test(binding_.session ?? "")) fail("PROOF_SESSION_IDENTITY");
  if (existsSync(join(session, "refused.json"))) fail("SOURCE_PROOF_DURABLY_REFUSED");
  const proof = json(join(session, "complete.json"));
  if (proof.schema !== "bullet.source-proof.v1" || proof.monitor_exit !== 0 || !same(proof.binding, binding_)
      || hash(bytes(join(session, "start.json"))) !== binding_.start_sha256
      || hash(bytes(join(session, "inventory.json"))) !== binding_.inventory_sha256
      || hash(bytes(join(session, "ack-00000000.json"))) !== binding_.ready_sha256
      || !same(proof.acknowledgements, acks(session)) || proof.acknowledgements.at(-1)?.command !== "FINISHED") fail("SOURCE_PROOF_COMPLETION_BINDING");
  if (revalidate) {
    const selected = json(join(session, "start.json"));
    const monitor = binding({ path: selected.monitor_path, sha256: selected.monitor_sha256 });
    const result = JSON.parse(execFileSync(monitor, ["--verify-inventory", join(session, "inventory.json")], {
      timeout: selected.response_seconds * 1000, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    if (!same(result, { inventory_sha256: binding_.inventory_sha256, outcome: "MATCH", schema: "bullet.source-monitor.revalidation.v1" })) fail("CURRENT_INPUT_REVALIDATION_REQUIRED");
    if (existsSync(join(session, "refused.json"))) fail("SOURCE_PROOF_DURABLY_REFUSED");
  }
  return proof;
}
function terminateMonitor() {
  const selected = json(join(sessionPath(), "start.json"));
  const monitor = binding({ path: selected.monitor_path, sha256: selected.monitor_sha256 });
  const pid = Number(process.env.BULLET_CI_SOURCE_MONITOR_PID);
  const owner = Number(process.env.BULLET_CI_SOURCE_OWNER_PID);
  const expected = process.env.BULLET_CI_SOURCE_MONITOR_START ?? "";
  const result = JSON.parse(execFileSync(monitor, ["--terminate-monitor", String(pid), expected, String(owner)], {
    timeout: Math.min(selected.response_seconds * 1000, 5000), killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  if (result.schema !== "bullet.source-monitor.termination.v1" || result.pid !== pid || result.owner_pid !== owner
      || result.expected_start !== expected || !["ORIGINAL_GONE", "IDENTITY_CHANGED_NOT_SIGNALED", "TERMINATED"].includes(result.outcome)) fail("TERMINATION_NOT_OBSERVED");
  record(join(sessionPath(), `termination-${randomUUID()}.json`), result);
}
export function recordFailure(childCode, monitorCode, message) {
  const session = sessionPath();
  record(join(session, "refused.json"), { schema: "bullet.source-proof.refusal.v1", child_exit: childCode,
    child_started: process.env.BULLET_CI_SOURCE_CHILD_STARTED === "true",
    monitor_exit: monitorCode, message, acknowledgements: acks(session) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "configure") console.log(configure(...args));
  else if (operation === "bootstrap") { const result = bootstrap(args[0]); console.log([result.path, result.sha256, result.tool_path].join("\n")); }
  else if (["READY", "CHECK", "FINISH"].includes(operation)) exchange(operation);
  else if (operation === "refuse") recordFailure(Number(args[0]), Number(args[1]), args[2]);
  else if (operation === "terminate") terminateMonitor();
  else fail("unknown control operation");
  } catch (error) { custodyFailureExit(error); }
}
