import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const lane = process.argv[2];
const policies = {
  fast: [
    ".ci-artifacts/reports/farmd-test-proxy-override.log",
    ".ci-artifacts/reports/vite-api-override.log",
    ".ci-artifacts/reports/vitest.json",
  ],
  lint: [],
  contract: [
    ".ci-artifacts/playwright/.last-run.json",
    ".ci-artifacts/reports/playwright.xml",
  ],
  security: [],
  docs: [],
  "scheduled-hygiene": [],
  coverage: [
    ".ci-artifacts/coverage/coverage-summary.json",
    ".ci-artifacts/reports/coverage-tests.json",
  ],
  portable: [
    ".ci-artifacts/platform/refusal.json",
    ".ci-artifacts/reports/farmd-test-proxy-override.log",
    ".ci-artifacts/reports/vite-api-override.log",
    ".ci-artifacts/reports/vitest.json",
  ],
};
if (!Object.hasOwn(policies, lane)) {
  throw new Error("CI_STAGE_LANE_INVALID: " + String(lane));
}

const artifactsRoot = ".ci-artifacts";
const observationPath = join(artifactsRoot, "observations", lane + ".json");
const patterns = [
  [
    "PRIVATE_KEY",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  ],
  ["GITHUB_TOKEN", /gh[pousr]_[A-Za-z0-9]{36,255}/],
  ["BULLET_BOOTSTRAP", /boot_[0-9a-f]{64}/],
  ["BULLET_WORKER", /wrk_[0-9a-f]{64}/],
];
const findings = [];
scanTree(artifactsRoot);
if (findings.length > 0) {
  throw new Error("ARTIFACT_REDACTION_FAILED: " + findings.join(", "));
}

requireRegular(observationPath, "CI_OBSERVATION_MISSING");
const observation = JSON.parse(readFileSync(observationPath, "utf8"));
if (
  observation?.repository !== "bullet-portal" ||
  observation?.outcomes?.length !== 1 ||
  observation.outcomes[0]?.lane !== lane ||
  !["PASS", "FAIL"].includes(observation.outcomes[0]?.status) ||
  !Array.isArray(observation.artifact_hashes)
) {
  throw new Error("CI_OBSERVATION_INVALID: " + lane);
}

const artifactPaths = new Set();
for (const artifact of observation.artifact_hashes) {
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    Object.keys(artifact).sort().join(",") !== "path,sha256" ||
    typeof artifact.path !== "string" ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    !validArtifactPath(artifact.path) ||
    !allowedArtifactPath(lane, artifact.path)
  ) {
    throw new Error("CI_ARTIFACT_ALLOWLIST_INVALID: " + String(artifact?.path));
  }
  if (artifactPaths.has(artifact.path)) {
    throw new Error("CI_ARTIFACT_DUPLICATE: " + artifact.path);
  }
  artifactPaths.add(artifact.path);
  requireRegular(artifact.path, "CI_ARTIFACT_MISSING");
  const actual = createHash("sha256")
    .update(readFileSync(artifact.path))
    .digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error("CI_ARTIFACT_HASH_MISMATCH: " + artifact.path);
  }
}

if (observation.outcomes[0].status === "PASS") {
  const actual = [...artifactPaths].sort();
  const expected = [...policies[lane]].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      "CI_ARTIFACT_INVENTORY_INVALID: " +
        lane +
        ": expected=" +
        expected.join(",") +
        " actual=" +
        actual.join(","),
    );
  }
}

const targetRoot = resolve("target");
const stageParent = join(targetRoot, "ci-upload");
const stageRoot = join(stageParent, lane);
for (const path of [targetRoot, stageParent, stageRoot]) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("CI_STAGE_ROOT_INVALID: " + path);
  }
}
mkdirSync(stageParent, { recursive: true, mode: 0o700 });
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { mode: 0o700 });

const staged = new Set();
stage(observationPath);
for (const path of artifactPaths) stage(path);
const actualStaged = walkFiles(stageRoot);
if ([...actualStaged].sort().join("\n") !== [...staged].sort().join("\n")) {
  throw new Error("CI_STAGE_INVENTORY_INVALID");
}
console.log("[ci] artifact redaction and exact " + lane + " staging passed");

function allowedArtifactPath(selectedLane, path) {
  if (policies[selectedLane].includes(path)) return true;
  return (
    selectedLane === "contract" &&
    /^\.ci-artifacts\/playwright\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/trace\.zip$/.test(
      path,
    )
  );
}

function validArtifactPath(path) {
  return (
    path.startsWith(".ci-artifacts/") &&
    path.length <= 1024 &&
    path.normalize("NFC") === path &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .slice(".ci-artifacts/".length)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function requireRegular(path, code) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(code + ": " + path);
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(code + ": " + path);
}

function stage(source) {
  const relative = source.slice(".ci-artifacts/".length);
  const destination = join(stageRoot, relative);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  staged.add(relative);
}

function scan(path, bytes) {
  const text = bytes.toString("utf8");
  for (const [code, pattern] of patterns) {
    if (pattern.test(text)) findings.push(path + ":" + code);
  }
}

function scanTree(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("CI_ARTIFACT_SYMLINK_REJECTED: " + full);
    if (entry.isDirectory()) scanTree(full);
    else if (entry.isFile() && entry.name.endsWith(".zip")) {
      scan(
        full,
        execFileSync("unzip", ["-p", full], { maxBuffer: 64 * 1024 * 1024 }),
      );
    } else if (entry.isFile()) scan(full, readFileSync(full));
    else throw new Error("CI_ARTIFACT_TYPE_INVALID: " + full);
  }
}

function walkFiles(root) {
  const files = new Set();
  visit(root, "");
  return files;
  function visit(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? relativeDirectory + "/" + entry.name
        : entry.name;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("CI_STAGE_SYMLINK_REJECTED: " + relative);
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) files.add(relative);
      else throw new Error("CI_STAGE_TYPE_INVALID: " + relative);
    }
  }
}
