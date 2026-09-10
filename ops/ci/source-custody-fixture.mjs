// Disposable regression fixtures only. These records are synthetic component
// evidence and never grant custody for a canonical checkout or installed proof.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const file = (path) => ({ path: realpathSync(path), sha256: hash(path) });
const write = (path, value) => { writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); return file(path); };
export function selected(name) {
  const result = process.env.PATH.split(":").map((p) => join(p, name)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  if (!result) throw new Error(`fixture tool required: ${name}`);
  return realpathSync(result);
}
export function copySources(origin, repo) {
  for (const relative of ["scripts/ci-local.sh", "ops/ci/observation.mjs", "ops/ci/source-custody.mjs", "ops/ci/required.sh", "ops/ci/lib.sh",
    "ops/ci/source-policy.json", "ops/ci/source-policy.mjs", "ops/ci/source-bootstrap.mjs",
    ...["Cargo.toml", "Cargo.lock", "README.md", "src/main.rs", "src/common.rs", "src/monitor.rs", "src/protocol.rs", "src/operations.rs"].map((p) => `ops/proof/source-monitor/${p}`)]) {
    mkdirSync(dirname(join(repo, relative)), { recursive: true });
    copyFileSync(join(origin, relative), join(repo, relative));
  }
}
export function admit(repo, lanes = ["fast"], extraTools = [], extraOutputs = []) {
  const temporaryRoot = process.env.BULLET_CI_FIXTURE_ROOT;
  if (!temporaryRoot || !repo.startsWith(`${realpathSync(temporaryRoot)}/`) || repo === realpathSync(temporaryRoot)) throw new Error("disposable fixture root required");
  const directory = `${repo}.source-admission`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  const source = { commit_oid: git("rev-parse", "HEAD"), tree_oid: git("rev-parse", "HEAD^{tree}") };
  const monitorPath = process.env.BULLET_CI_SOURCE_MONITOR_BIN;
  const rustcPath = process.env.BULLET_CI_SOURCE_RUSTC;
  const cargoPath = process.env.BULLET_CI_SOURCE_CARGO;
  if (![monitorPath, rustcPath, cargoPath].every((p) => p && p.startsWith("/") && existsSync(p))) throw new Error("admitted monitor and Rust fixture tool subjects required");
  const sources = ["Cargo.toml", "Cargo.lock", "README.md", "src/main.rs", "src/common.rs", "src/monitor.rs", "src/protocol.rs", "src/operations.rs"].map((p) => file(join(repo, "ops/proof/source-monitor", p)));
  const buildTools = [{ name: "rustc", ...file(rustcPath) }, { name: "cargo", ...file(cargoPath) }];
  const build = write(join(directory, "monitor-build.json"), { schema: "bullet.source-monitor.build.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY",
    executable_sha256: hash(monitorPath), sources, tools: buildTools });
  const grant = write(join(directory, "synthetic-grant.json"), { evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", fixture: repo, writer: "fixture-controller" });
  const release = write(join(directory, "synthetic-release.json"), { evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", fixture: repo, state: "released" });
  const writerRelease = write(join(directory, "writer-release.json"), { schema: "bullet.source-writer-release.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY",
    checkout: repo, source, all_potential_writers_listed: true, writers: [{ identity: "fixture-controller", state: "released", grant, release }] });
  const names = ["bash", "node", "git", "timeout", "stat", "wc", "mkdir", "rm", "rmdir", "uname", "dirname", "sleep", "env", "cp", "chmod", "cat", ...extraTools];
  const tools = [...new Set(names)].map((name) => ({ name, ...file(selected(name)) }));
  const toolPath = join(directory, "bin"); mkdirSync(toolPath, { mode: 0o700 });
  for (const tool of tools) symlinkSync(tool.path, join(toolPath, tool.name));
  // Explicit fixture outputs. This list is never derived from .gitignore.
  if (!Array.isArray(extraOutputs) || extraOutputs.some((p) => typeof p !== "string" || p.startsWith("/") || p.split("/").includes(".."))) throw new Error("explicit relative fixture outputs required");
  const outputs = [".ci-artifacts", "child.log", "report", "outside", "outside-dir", "modes", "ready", "lane.pid", "release", "publication", "dispatcher.output", "retained-git", ...extraOutputs]
    .map((p) => ({ path: join(repo, p), reason: "explicit disposable fixture output/control" }));
  const admission = { schema: "bullet.source-admission.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY", author: "fixture-author", repository: "bullet-portal", checkout: repo,
    lanes, path: toolPath, source, monitor: { ...file(monitorPath), build }, input_roots: [realpathSync(rustcPath), toolPath], tools,
    outputs, writer_release: writerRelease, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_seconds: 300, response_seconds: 30,
    inputs_complete: true, tools_complete: true, conditions: { cooperative_freeze: true, local_filesystem: true, no_mmap_writers: true, no_mount_changes: true } };
  const review = write(join(directory, "synthetic-review.json"), { schema: "bullet.source-admission-review.v1", evidence_class: "DIAGNOSTIC_COMPONENT_ONLY",
    fixture: repo, reviewer: "fixture-reviewer", verdict: "accepted", admission_subject_sha256: createHash("sha256").update(JSON.stringify(admission)).digest("hex") });
  return { ...write(join(directory, "admission.json"), { ...admission, review }), tool_path: toolPath };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "copy") copySources(...args);
  else if (operation === "admit") console.log(admit(...args).sha256);
  else throw new Error("fixture operation required");
}
