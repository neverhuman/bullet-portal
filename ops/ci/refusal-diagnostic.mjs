// Publication-refusal diagnostics contain no raw logs, environment, credentials,
// test claims, authority receipts, or arbitrary error strings.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const lanes = ["fast", "lint", "contract", "rendered", "security", "docs", "coverage", "scheduled-hygiene", "portable"];
const fail = () => { throw new Error("CI_REFUSAL_DIAGNOSTIC_INVALID"); };
const pathFor = (lane) => `.ci-artifacts/diagnostics/${lane}-refusal.json`;
function inspect(path, kind, optional = false) {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    let stat;
    try { stat = lstatSync(parts.slice(0, i).join("/")); }
    catch (error) { if (optional && error.code === "ENOENT") return false; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length || kind === "directory" ? !stat.isDirectory() : !stat.isFile())) fail();
  }
  return true;
}
function directory(path) {
  if (inspect(path, "directory", true)) return;
  if (dirname(path) !== ".") directory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
}
function validate(value, lane) {
  const keys = ["schema", "evidence_class", "lane", "lane_outcome", "lane_exit_code", "observation_exit_code", "source_proof", "release_eligible"];
  if (!lanes.includes(lane) || !value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
      || value.schema !== "bullet.ci-publication-refusal.v1" || value.evidence_class !== "DIAGNOSTIC_ONLY"
      || value.lane !== lane || value.source_proof !== "UNAVAILABLE" || value.release_eligible !== false
      || !["failure", "cancelled", "skipped", "unexecuted"].includes(value.lane_outcome)
      || !Number.isInteger(value.lane_exit_code) || value.lane_exit_code < 1 || value.lane_exit_code > 255
      || !Number.isInteger(value.observation_exit_code) || value.observation_exit_code < 1 || value.observation_exit_code > 255) fail();
}
export function recordRefusalDiagnostic(lane, outcome, code, observerCode) {
  const value = { schema: "bullet.ci-publication-refusal.v1", evidence_class: "DIAGNOSTIC_ONLY", lane,
    lane_outcome: outcome === "" ? "unexecuted" : outcome, lane_exit_code: Number(code),
    observation_exit_code: Number(observerCode), source_proof: "UNAVAILABLE", release_eligible: false };
  validate(value, lane);
  // A present observation/proof, even malformed, must use normal validation.
  if (inspect(`.ci-artifacts/observations/${lane}.json`, "file", true)
      || inspect(`.ci-artifacts/reports/${lane}-source-proof.json`, "file", true)) fail();
  directory(".ci-artifacts/diagnostics");
  writeFileSync(pathFor(lane), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}
export function stageRefusalDiagnostic(lane) {
  if (!lanes.includes(lane)) fail();
  const path = pathFor(lane);
  if (!inspect(path, "file", true)) return false;
  if (inspect(`.ci-artifacts/observations/${lane}.json`, "file", true)
      || inspect(`.ci-artifacts/reports/${lane}-source-proof.json`, "file", true)) fail();
  if (lstatSync(path).size > 2048) fail();
  const value = JSON.parse(readFileSync(path, "utf8"));
  validate(value, lane);
  const stage = `target/ci-upload/${lane}`;
  // Never retain files from an older successful stage alongside this refusal.
  if (inspect(stage, "directory", true)) fail();
  directory(`${stage}/diagnostics`);
  writeFileSync(`${stage}/diagnostics/${lane}-refusal.json`, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  console.log("[ci] refusal diagnostic staged; observation and source proof remain unavailable");
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  recordRefusalDiagnostic(...process.argv.slice(2));
}
