import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expected = ["fast", "lint", "contract", "security", "docs"];
const observationKeys = [
  "artifact_hashes",
  "clean",
  "commands",
  "commit_oid",
  "evidence_class",
  "outcomes",
  "repository",
  "schema_version",
  "signed",
  "tool_versions",
  "tree_oid",
].sort();
const sha256Pattern = /^[0-9a-f]{64}$/;
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function validateNeeds(needs) {
  if (!isObject(needs)) fail("INVALID_NEEDS", "needs must be an object");
  const keys = Object.keys(needs).sort();
  const wanted = [...expected].sort();
  if (!sameArray(keys, wanted)) {
    fail("MISSING_REQUIRED_JOB", `expected ${wanted.join(",")}; got ${keys.join(",")}`);
  }
  for (const lane of expected) {
    const job = needs[lane];
    if (job?.result !== "success") {
      fail("REQUIRED_JOB_NOT_SUCCESSFUL", `${lane}=${job?.result ?? "missing"}`);
    }
    if (job?.outputs?.observation !== "true") {
      fail("MISSING_CI_OBSERVATION", lane);
    }
  }
  return expected;
}

export function validateRequiredRun(artifactRoot, expectedCommit, needs) {
  validateNeeds(needs);
  if (!oidPattern.test(expectedCommit ?? "")) {
    fail("INVALID_EXPECTED_COMMIT", expectedCommit ?? "missing");
  }
  const expectedTree = resolveExpectedTree(expectedCommit);
  const root = resolve(artifactRoot);
  const rootStat = safeLstat(root, "CI_ARTIFACT_ROOT_MISSING");
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("CI_ARTIFACT_ROOT_INVALID", artifactRoot);
  }

  const expectedFiles = new Set(expected.map((lane) => `observations/${lane}.json`));
  const boundArtifacts = new Set();
  for (const lane of expected) {
    const relativeObservation = `observations/${lane}.json`;
    const observationPath = requireRegularPath(root, relativeObservation, "CI_OBSERVATION_MISSING");
    const observation = readObservation(observationPath, lane);
    validateObservation(observation, lane, expectedCommit, expectedTree);

    for (const artifact of observation.artifact_hashes) {
      validateArtifactEntry(artifact, lane);
      if (boundArtifacts.has(artifact.path)) {
        fail("CI_ARTIFACT_DUPLICATE", artifact.path);
      }
      boundArtifacts.add(artifact.path);
      const downloadedRelative = artifact.path.slice(".ci-artifacts/".length);
      const artifactPath = requireRegularPath(root, downloadedRelative, "CI_ARTIFACT_MISSING");
      const actual = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
      if (actual !== artifact.sha256) {
        fail("CI_ARTIFACT_HASH_MISMATCH", artifact.path);
      }
      expectedFiles.add(downloadedRelative);
    }
  }

  const actualFiles = walkRegularFiles(root);
  if (!sameArray([...actualFiles].sort(), [...expectedFiles].sort())) {
    fail(
      "CI_ARTIFACT_INVENTORY_INVALID",
      `expected ${[...expectedFiles].sort().join(",")}; got ${[...actualFiles].sort().join(",")}`,
    );
  }
  return expected;
}

function readObservation(path, lane) {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    fail("CI_OBSERVATION_INVALID", `${lane}: invalid size`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CI_OBSERVATION_INVALID", `${lane}: malformed JSON`);
  }
}

function validateObservation(observation, lane, expectedCommit, expectedTree) {
  const valid =
    isObject(observation) &&
    sameArray(Object.keys(observation).sort(), observationKeys) &&
    observation.schema_version === "bullet.ci-observation.v1" &&
    observation.repository === "bullet-portal" &&
    observation.commit_oid === expectedCommit &&
    observation.tree_oid === expectedTree &&
    observation.clean === true &&
    sameArray(observation.commands, [`bash scripts/ci-local.sh ${lane}`]) &&
    isObject(observation.tool_versions) &&
    Object.values(observation.tool_versions).every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
    JSON.stringify(observation.outcomes) ===
      JSON.stringify([{ lane, status: "PASS", exit_code: 0 }]) &&
    Array.isArray(observation.artifact_hashes) &&
    observation.signed === false &&
    observation.evidence_class === "DIAGNOSTIC_ONLY";
  if (!valid) fail("CI_OBSERVATION_INVALID", lane);
}

function resolveExpectedTree(expectedCommit) {
  let tree;
  try {
    tree = execFileSync("git", ["rev-parse", "--verify", `${expectedCommit}^{tree}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("EXPECTED_TREE_UNAVAILABLE", expectedCommit);
  }
  if (!oidPattern.test(tree ?? "")) fail("EXPECTED_TREE_UNAVAILABLE", expectedCommit);
  return tree;
}

function validateArtifactEntry(artifact, lane) {
  if (
    !isObject(artifact) ||
    !sameArray(Object.keys(artifact).sort(), ["path", "sha256"]) ||
    typeof artifact.path !== "string" ||
    artifact.path.length > 1024 ||
    artifact.path.normalize("NFC") !== artifact.path ||
    !artifact.path.startsWith(".ci-artifacts/") ||
    artifact.path.includes("\\") ||
    artifact.path.includes("\0") ||
    artifact.path
      .slice(".ci-artifacts/".length)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    !sha256Pattern.test(artifact.sha256 ?? "")
  ) {
    fail("CI_ARTIFACT_PATH_INVALID", `${lane}:${String(artifact?.path)}`);
  }
}

function requireRegularPath(root, relative, missingCode) {
  let current = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = safeLstat(current, missingCode);
    if (stat.isSymbolicLink()) fail("CI_ARTIFACT_SYMLINK_REJECTED", relative);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail("CI_ARTIFACT_PATH_INVALID", relative);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      fail("CI_ARTIFACT_NOT_REGULAR", relative);
    }
  }
  return current;
}

function walkRegularFiles(root) {
  const files = new Set();
  visit(root, "");
  return files;

  function visit(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("CI_ARTIFACT_SYMLINK_REJECTED", relative);
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) files.add(relative);
      else fail("CI_ARTIFACT_NOT_REGULAR", relative);
    }
  }
}

function safeLstat(path, missingCode) {
  try {
    return lstatSync(path);
  } catch {
    fail(missingCode, path);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameArray(actual, expectedArray) {
  return (
    Array.isArray(actual) &&
    actual.length === expectedArray.length &&
    actual.every((value, index) => value === expectedArray[index])
  );
}

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--jeryu") {
    fail(
      "JERYU_STATUS_BINDING_UNRATIFIED",
      "predecessor outcomes and exact artifact layout are not ratified",
    );
  } else {
    const raw = process.env.NEEDS_JSON;
    if (!raw) fail("MISSING_NEEDS_JSON", "environment variable is absent");
    let needs;
    try {
      needs = JSON.parse(raw);
    } catch {
      fail("INVALID_NEEDS_JSON", "malformed JSON");
    }
    const artifactRoot = process.argv[2];
    const expectedCommit = process.argv[3];
    if (!artifactRoot || !expectedCommit) {
      fail("USAGE", "aggregate.mjs <artifact-root> <expected-commit>");
    }
    const lanes = validateRequiredRun(artifactRoot, expectedCommit, needs);
    console.log(
      `[ci] required convergence passed: ${lanes.join(", ")}; exact clean observations and artifact hashes verified`,
    );
  }
}
