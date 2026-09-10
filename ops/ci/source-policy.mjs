// Finite read-only policy evaluation; Rust remains the live proof authority.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const refuse = (message) => { throw new Error(`CI_SOURCE_POLICY: ${message}`); };
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const monitorSources = Object.freeze(["Cargo.toml", "Cargo.lock", "README.md", "src/main.rs", "src/common.rs", "src/monitor.rs", "src/protocol.rs", "src/operations.rs", "src/lookup.rs", "src/lookup_tests.rs"]);
const sha = /^[a-f0-9]{64}$/;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export function regular(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !lstatSync(path).isFile()) refuse("canonical regular input required");
  return path;
}
export function read(binding) {
  if (!sha.test(binding?.sha256 ?? "")) refuse("hash binding required");
  const bytes = readFileSync(regular(binding.path));
  if (digest(bytes) !== binding.sha256) refuse("static input changed");
  return JSON.parse(bytes);
}
export function file(path) { return { path: regular(path), sha256: digest(readFileSync(path)) }; }
export function lookupInputs(entries = [], checkout) {
  if (!Array.isArray(entries) || entries.length > 4096) refuse("bounded explicit lookup array required");
  const seen = new Set();
  const path = (value) => {
    if (checkout && typeof value === "string" && (value === "$CHECKOUT" || value.startsWith("$CHECKOUT/"))) value = `${checkout}${value.slice(9)}`;
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value)) refuse("absolute normalized lookup path required");
    return value;
  };
  return entries.map((entry) => {
    if (!entry || !same(Object.keys(entry).sort(), ["kind", "path", "target"]) || !["file", "directory", "absent"].includes(entry.kind)
        || (entry.kind === "absent") !== (entry.target === null)) refuse("typed lookup declaration required");
    const observed = { path: path(entry.path), kind: entry.kind, target: entry.target === null ? null : path(entry.target) };
    if (seen.has(observed.path)) refuse("duplicate lookup path");
    seen.add(observed.path); return observed;
  });
}
export function staticPolicy(policyReference, reviewReference, profileReference) {
  const policy = read(policyReference); const review = read(reviewReference); const profile = read(profileReference);
  if (policy.schema !== "bullet.source-policy.v1" || policy.evidence_class !== "DIAGNOSTIC_COMPONENT_ONLY"
      || policy.platform !== "linux" || policy.runner_environment !== "github-hosted"
      || !["require_only_owned_process_ancestry", "require_raw_committed_source", "require_pinned_tools_and_complete_inputs", "require_explicit_outputs"].every((p) => policy[p] === true)
      || !same(policy.conditions, { cooperative_freeze: true, local_filesystem: true, no_mmap_writers: true, no_mount_changes: true })
      || !Number.isSafeInteger(policy.max_seconds) || policy.max_seconds < 1 || policy.max_seconds > 86400
      || !Number.isSafeInteger(policy.response_seconds) || policy.response_seconds < 1 || policy.response_seconds > 60) refuse("unsupported policy");
  if (review.schema !== "bullet.source-policy-review.v1" || review.verdict !== "accepted"
      || typeof review.reviewer !== "string" || !review.reviewer || review.reviewer === policy.author
      || review.policy_sha256 !== policyReference.sha256 || review.tool_profile_sha256 !== profileReference.sha256
      || !Array.isArray(review.evaluator_sources)) refuse("independent static policy review required");
  const sourceNames = ["source-policy.mjs", "source-bootstrap.mjs", "source-custody.mjs"];
  if (!same(review.evaluator_sources.map((s) => s.name).sort(), sourceNames.sort())) refuse("reviewed evaluator inventory");
  for (const source of review.evaluator_sources) {
    if (!sha.test(source.sha256 ?? "") || digest(readFileSync(join(moduleDirectory, source.name))) !== source.sha256) refuse("policy evaluator changed");
  }
  if (profile.schema !== "bullet.source-tool-profile.v1" || profile.platform !== "linux"
      || profile.inputs_complete !== true || profile.tools_complete !== true || !Array.isArray(profile.tools)
      || !Array.isArray(profile.input_roots) || !Array.isArray(profile.outputs)) refuse("reviewed complete tool profile required");
  if (!sha.test(profile.monitor?.executable_sha256 ?? "") || !Array.isArray(profile.monitor?.sources)
      || !Array.isArray(profile.monitor?.tools)) refuse("independently pinned monitor build required");
  const names = new Set();
  for (const tool of profile.tools) {
    if (!/^[a-z0-9][a-z0-9._+-]*$/.test(tool.name ?? "") || names.has(tool.name) || !sha.test(tool.sha256 ?? "")
        || !Array.isArray(tool.version_args) || typeof tool.version_first_line !== "string" || !tool.version_first_line) refuse("pinned tool identity/version required");
    names.add(tool.name);
  }
  for (const name of ["bash", "node", "git", "timeout", "stat", "wc", "mkdir", "rm", "rmdir", "uname", "dirname", "sleep", "env", "cargo", "rustc"]) {
    if (!names.has(name)) refuse(`tool profile missing ${name}`);
  }
  return { policy, profile, review };
}
export function validateMonitor(profile, executable, build) {
  const pinned = profile.monitor;
  if (build.schema !== "bullet.source-monitor.build.v1" || executable.sha256 !== pinned.executable_sha256
      || build.executable_sha256 !== pinned.executable_sha256 || typeof build.source_root !== "string"
      || realpathSync(build.source_root) !== build.source_root || !lstatSync(build.source_root).isDirectory()) refuse("monitor executable/build not independently admitted");
  if (!same(pinned.sources.map((s) => s.name).sort(), [...monitorSources].sort())
      || !same(build.sources.map((s) => s.path).sort(), monitorSources.map((n) => join(build.source_root, n)).sort())) refuse("monitor source inventory differs from policy");
  for (const source of pinned.sources) {
    const observed = build.sources.find((s) => s.path === join(build.source_root, source.name));
    if (!sha.test(source.sha256 ?? "") || observed.sha256 !== source.sha256 || file(observed.path).sha256 !== source.sha256) refuse("monitor source differs from independent policy");
  }
  if (!same(pinned.tools.map((t) => t.name).sort(), ["cargo", "rustc"])) refuse("monitor build tool pin inventory");
  if (!same(build.tools.map((t) => t.name).sort(), ["cargo", "rustc"])) refuse("monitor build tool subject inventory");
  for (const tool of pinned.tools) {
    const observed = build.tools.find((t) => t.name === tool.name);
    if (!sha.test(tool.sha256 ?? "") || observed.sha256 !== tool.sha256 || file(observed.path).sha256 !== tool.sha256) refuse("monitor build tool differs from independent policy");
  }
}
function processIdentity(pid) {
  const root = `/proc/${pid}`; const stat = readFileSync(`${root}/stat`, "utf8").split(/\) /).at(-1).trim().split(/\s+/);
  if (["Z", "X"].includes(stat[0])) refuse("process not live");
  if (!/^\d+$/.test(stat[19] ?? "") || !/^\d+$/.test(stat[1] ?? "")) refuse("process identity unavailable");
  return { pid, parent_pid: Number(stat[1]), start: stat[19], uid: lstatSync(root).uid };
}
export function observeHosted(checkout, ownerPid, monitorPid = null) {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
      || process.env.RUNNER_OS !== "Linux" || process.env.GITHUB_WORKSPACE !== checkout || realpathSync(checkout) !== checkout
      || !Number.isSafeInteger(ownerPid) || ownerPid < 2) refuse("hosted Linux checkout/owner required");
  const context = Object.fromEntries(["GITHUB_REPOSITORY", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_ENVIRONMENT", "RUNNER_OS"].map((key) => [key, process.env[key]]));
  if (!/^\d+$/.test(context.GITHUB_RUN_ID ?? "") || !/^[1-9]\d*$/.test(context.GITHUB_RUN_ATTEMPT ?? "")
      || !/^[a-f0-9]{40,64}$/.test(context.GITHUB_SHA ?? "") || !context.GITHUB_JOB || !context.GITHUB_REF) refuse("actual hosted run identity required");
  const owned = new Map(); let cursor = process.pid;
  while (cursor > 1) {
    const observed = processIdentity(cursor); owned.set(cursor, observed); cursor = observed.parent_pid;
  }
  if (!owned.has(ownerPid)) refuse("wrapper owner must be an ancestor");
  if (monitorPid !== null) {
    const monitor = processIdentity(monitorPid);
    if (monitor.parent_pid !== ownerPid || monitor.start !== process.env.BULLET_CI_SOURCE_MONITOR_START) refuse("owned monitor identity required");
    owned.set(monitorPid, monitor);
  }
  for (const entry of readdirSync("/proc").filter((p) => /^[1-9]\d*$/.test(p))) {
    const pid = Number(entry);
    try {
      if (lstatSync(`/proc/${pid}`).uid === process.getuid() && !owned.has(pid)) refuse(`unreleased same-user process ${pid}`);
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  return { schema: "bullet.source-hosted-observation.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", checkout,
    context, owner: owned.get(ownerPid), processes: [...owned.values()].sort((a, b) => a.pid - b.pid), observed_at: new Date().toISOString() };
}
export function validateContext(policy, observation, source, lane) {
  if (observation.schema !== "bullet.source-hosted-observation.v1" || observation.evidence_class !== "DIAGNOSTIC_COMPONENT_ONLY"
      || !policy.repositories.includes(observation.context.GITHUB_REPOSITORY) || !policy.events.includes(observation.context.GITHUB_EVENT_NAME)
      || !policy.lanes.includes(lane) || observation.context.GITHUB_SHA !== source.commit_oid) refuse("run/source/event/lane outside reviewed policy");
}
export function validatePolicyAdmission(admission, checkout) {
  const evaluation = read(admission.review);
  if (evaluation.schema !== "bullet.source-policy-evaluation.v1" || evaluation.verdict !== "admitted-diagnostic"
      || evaluation.evidence_class !== "DIAGNOSTIC_COMPONENT_ONLY") refuse("policy evaluation required");
  const { review: _, ...subject } = admission;
  if (evaluation.admission_subject_sha256 !== digest(Buffer.from(JSON.stringify(subject)))) refuse("evaluation subject changed");
  const { policy, profile } = staticPolicy(evaluation.policy, evaluation.policy_review, evaluation.tool_profile);
  validateMonitor(profile, file(admission.monitor.path), read(admission.monitor.build));
  const observation = read(evaluation.runtime); const release = read(admission.writer_release);
  const current = observeHosted(checkout, Number(process.env.BULLET_CI_SOURCE_OWNER_PID), process.env.BULLET_CI_SOURCE_MONITOR_PID ? Number(process.env.BULLET_CI_SOURCE_MONITOR_PID) : null);
  if (!same(current.context, observation.context) || !same(current.owner, observation.owner)
      || release.schema !== "bullet.source-hosted-writer-policy.v1" || release.evidence_class !== "DIAGNOSTIC_COMPONENT_ONLY"
      || !same(release.runtime, evaluation.runtime) || !same(release.source, admission.source)
      || !same(admission.conditions, policy.conditions) || admission.max_seconds !== policy.max_seconds || admission.response_seconds !== policy.response_seconds) refuse("hosted writer policy observation changed");
  const expectedTools = profile.tools.map((tool) => ({ name: tool.name, sha256: tool.sha256 })).sort((a, b) => a.name.localeCompare(b.name));
  const observedTools = admission.tools.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name));
  if (!same(expectedTools, observedTools) || !same(observation.tools?.map(({ version: _, ...tool }) => tool), admission.tools)
      || observation.tools.some((tool) => tool.version !== profile.tools.find((p) => p.name === tool.name)?.version_first_line)) refuse("tool profile projection changed");
  const expectedInputs = [...profile.input_roots.map((p) => p === "$CHECKOUT" ? checkout : p), admission.path,
    evaluation.policy.path, evaluation.policy_review.path, evaluation.tool_profile.path, evaluation.runtime.path];
  const expectedOutputs = profile.outputs.map(({ path, reason }) => ({ path: join(checkout, path), reason }));
  if (!same(admission.input_roots, expectedInputs) || !same(admission.outputs, expectedOutputs)
      || !same(lookupInputs(admission.lookups), lookupInputs(profile.lookups, checkout))
      || !admission.path.startsWith(`${process.env.RUNNER_TEMP}/bullet-source-admission-`) || !admission.path.endsWith("/bin")) refuse("reviewed input/output projection changed");
  for (const lane of admission.lanes) validateContext(policy, observation, admission.source, lane);
  if (existsSync(join(checkout, ".git/bullet-ci.lock.d", "refused.json"))) refuse("refused owner custody");
  return [evaluation.policy.path, evaluation.policy_review.path, evaluation.tool_profile.path, evaluation.runtime.path,
    ...["source-policy.mjs", "source-bootstrap.mjs", "source-custody.mjs"].map((name) => join(moduleDirectory, name))];
}
