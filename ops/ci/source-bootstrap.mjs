// One-shot engineering bootstrap. No daemon, credentials, operator acts or live
// provider authority. Static review is reused only through exact source hashes.
import { execFileSync } from "node:child_process";
import { constants, accessSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, file, lookupInputs, observeHosted, read, refuse, staticPolicy, validateContext, validateMonitor } from "./source-policy.mjs";

function envBinding(name) {
  const path = process.env[`BULLET_CI_${name}`]; const sha256 = process.env[`BULLET_CI_${name}_SHA256`];
  if (!path || !sha256) refuse(`${name} hash-bound prerequisite required`);
  return { path, sha256 };
}
function record(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  return file(path);
}
function selected(name) {
  const path = process.env.PATH.split(":").map((p) => join(p, name)).find((p) => { try { accessSync(p, constants.X_OK); return lstatSync(p).isFile() || lstatSync(p).isSymbolicLink(); } catch { return false; } });
  if (!path) refuse(`tool unavailable: ${name}`);
  return realpathSync(path);
}
export function bootstrap(lane) {
  const checkout = process.cwd();
  const policyReference = envBinding("SOURCE_POLICY"); const reviewReference = envBinding("SOURCE_POLICY_REVIEW"); const profileReference = envBinding("SOURCE_TOOL_PROFILE");
  const { policy, profile } = staticPolicy(policyReference, reviewReference, profileReference);
  const buildReference = envBinding("SOURCE_MONITOR_BUILD"); const build = read(buildReference);
  const monitorPath = process.env.BULLET_CI_SOURCE_MONITOR_BIN;
  if (!monitorPath || build.schema !== "bullet.source-monitor.build.v1" || file(monitorPath).sha256 !== build.executable_sha256) refuse("prepared pinned monitor build required");
  validateMonitor(profile, file(monitorPath), build);
  const observed = observeHosted(checkout, Number(process.env.BULLET_CI_SOURCE_OWNER_PID));
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || realpathSync(temporary) !== temporary || !lstatSync(temporary).isDirectory() || temporary === checkout || temporary.startsWith(`${checkout}/`)) refuse("private external runner temporary root required");
  const directory = mkdtempSync(join(temporary, "bullet-source-admission-"));
  const toolPath = join(directory, "bin"); mkdirSync(toolPath, { mode: 0o700 });
  const tools = profile.tools.map((tool) => {
    const path = selected(tool.name); const subject = file(path);
    if (subject.sha256 !== tool.sha256) refuse(`tool hash changed: ${tool.name}`);
    return { name: tool.name, ...subject };
  });
  if (tools.find((tool) => tool.name === "node").path !== realpathSync(process.execPath)) refuse("bootstrap Node subject differs from selected tool");
  observed.tools = tools.map((subject) => {
    const tool = profile.tools.find((tool) => tool.name === subject.name); const path = subject.path;
    const version = execFileSync(path, tool.version_args, { encoding: "utf8", timeout: 10_000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] }).split(/\r?\n/)[0];
    if (version !== tool.version_first_line) refuse(`tool version changed: ${tool.name}`);
    symlinkSync(path, join(toolPath, tool.name));
    return { ...subject, version };
  });
  const git = (...args) => execFileSync(tools.find((tool) => tool.name === "git").path, args, { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  const source = { commit_oid: git("rev-parse", "HEAD"), tree_oid: git("rev-parse", "HEAD^{tree}") };
  validateContext(policy, observed, source, lane);
  const runtime = record(join(directory, "runtime.json"), observed);
  const writerRelease = record(join(directory, "writer-policy.json"), { schema: "bullet.source-hosted-writer-policy.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", runtime, source });
  const inputs = profile.input_roots.map((p) => p === "$CHECKOUT" ? checkout : p);
  for (const path of inputs) if (!path.startsWith("/") || resolve(path) !== path || realpathSync(path) !== path) refuse("canonical reviewed input root required");
  const outputs = profile.outputs.map(({ path, reason }) => {
    if (typeof path !== "string" || path.startsWith("/") || path.split("/").some((p) => ["", ".", ".."].includes(p)) || !reason) refuse("explicit relative output required");
    return { path: join(checkout, path), reason };
  });
  const lookups = lookupInputs(profile.lookups, checkout);
  const admission = { schema: "bullet.source-admission.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", author: "reviewed diagnostic policy evaluator",
    repository: "bullet-portal", checkout, lanes: [lane], path: toolPath, source,
    monitor: { ...file(monitorPath), build: buildReference }, input_roots: [...inputs, toolPath, policyReference.path, reviewReference.path, profileReference.path, runtime.path],
    tools, outputs, ...(lookups.length ? { lookups } : {}), writer_release: writerRelease, expires_at: new Date(Date.now() + (policy.max_seconds + 300) * 1000).toISOString(),
    max_seconds: policy.max_seconds, response_seconds: policy.response_seconds, inputs_complete: true, tools_complete: true, conditions: policy.conditions };
  const evaluation = record(join(directory, "evaluation.json"), { schema: "bullet.source-policy-evaluation.v1", verdict: "admitted-diagnostic", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY",
    policy: policyReference, policy_review: reviewReference, tool_profile: profileReference, runtime,
    admission_subject_sha256: digest(Buffer.from(JSON.stringify(admission))) });
  return { ...record(join(directory, "admission.json"), { ...admission, review: evaluation }), tool_path: toolPath };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(bootstrap(process.argv[2])));
