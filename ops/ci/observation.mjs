import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [lane, outcome, exitCodeText, ...observedCommands] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*$/.test(lane ?? "")) throw new Error("invalid lane");
if (!/^(?:success|failure|cancelled|skipped)$/.test(outcome ?? "")) throw new Error("invalid outcome");
const exitCode = Number(exitCodeText);
if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error("invalid exit code");
if ((outcome === "success") !== (exitCode === 0)) throw new Error("outcome and exit code disagree");
const run = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
};
const artifactsRoot = ".ci-artifacts";
const observationDir = join(artifactsRoot, "observations");
mkdirSync(observationDir, { recursive: true });
const artifacts = [];
walk(artifactsRoot);
const report = {
  schema_version: "bullet.ci-observation.v1",
  repository: "bullet-portal",
  commit_oid: run("git", ["rev-parse", "HEAD"]),
  tree_oid: run("git", ["rev-parse", "HEAD^{tree}"]),
  clean: run("git", ["status", "--porcelain", "--untracked-files=normal"]) === "",
  commands:
    observedCommands.length > 0
      ? observedCommands
      : new Set(["skipped", "cancelled"]).has(outcome)
        ? []
        : [`bash scripts/ci-local.sh ${lane}`],
  tool_versions: {
    node: run("node", ["--version"]),
    npm: run("npm", ["--version"]),
    actionlint: run("actionlint", ["-version"]).split("\n", 1)[0],
    shellcheck: run("shellcheck", ["--version"]).match(/version: ([^\n]+)/)?.[1] ?? "unavailable",
    gitleaks: run("gitleaks", ["version"]),
    zizmor: run("zizmor", ["--version"]),
  },
  outcomes: [{ lane, status: outcome === "success" ? "PASS" : "FAIL", exit_code: exitCode }],
  artifact_hashes: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
  signed: false,
  evidence_class: "DIAGNOSTIC_ONLY",
};
const destination = join(observationDir, `${lane}.json`);
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`[ci] wrote unsigned observation ${destination}`);

function walk(path) {
  for (const name of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, name.name);
    if (name.isDirectory()) {
      if (full !== observationDir) walk(full);
    } else if (name.isFile() && !full.startsWith(`${observationDir}/`)) {
      const bytes = readFileSync(full);
      artifacts.push({
        path: relative(".", full),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
