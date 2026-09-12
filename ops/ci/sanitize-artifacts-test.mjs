import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { syntheticSourceProof } from "./source-proof-fixture.mjs";

const script = resolve("ops/ci/sanitize-artifacts.mjs");
const run = (root) =>
  spawnSync(process.execPath, [script, "fast"], {
    cwd: root,
    encoding: "utf8",
  });
let root = makeFixture();
try {
  const result = run(root);
  assert(result.status === 0, `exact staged fixture failed: ${result.stderr}`);
  for (const path of [
    "observations/fast.json",
    "reports/farmd-test-proxy-override.log",
    "reports/vite-api-override.log",
    "reports/vitest.json",
    "reports/fast-source-proof.json",
  ]) {
    assert(
      existsSync(join(root, "target/ci-upload/fast", path)),
      `staged file missing: ${path}`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

refusal("unlisted artifact", (fixture, observation) => {
  const path = join(fixture, ".ci-artifacts/raw.log");
  writeFileSync(path, "raw\n");
  observation.artifact_hashes.push({
    path: ".ci-artifacts/raw.log",
    sha256: hash(path),
  });
});
refusal("duplicate artifact", (_fixture, observation) => {
  observation.artifact_hashes.push({...observation.artifact_hashes[0]});
});
refusal("hash mismatch", (_fixture, observation) => {
  observation.artifact_hashes[0].sha256 = "0".repeat(64);
});
refusal("symlinked report", (fixture) => {
  const path = join(fixture, ".ci-artifacts/reports/vitest.json");
  rmSync(path);
  symlinkSync("vite-api-override.log", path);
});
refusal("secret-shaped report", (fixture, observation) => {
  const path = join(fixture, ".ci-artifacts/reports/vitest.json");
  writeFileSync(path, "gh" + "p_" + "A".repeat(36));
  observation.artifact_hashes.find((entry) =>
    entry.path.endsWith("vitest.json"),
  ).sha256 = hash(path);
});
console.log(
  "[ci] staged-artifact allowlist, hash, symlink, and redaction hostiles passed",
);

function refusal(label, mutate) {
  const fixture = makeFixture();
  try {
    const observationPath = join(
      fixture,
      ".ci-artifacts/observations/fast.json",
    );
    const observation = JSON.parse(readFileSync(observationPath, "utf8"));
    mutate(fixture, observation);
    writeFileSync(observationPath, JSON.stringify(observation) + "\n");
    assert(run(fixture).status !== 0, `sanitizer accepted ${label}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function makeFixture() {
  const fixture = mkdtempSync(join(tmpdir(), "bullet-portal-stage-"));
  const bodies = {
    ".ci-artifacts/reports/farmd-test-proxy-override.log": "typed refusal\n",
    ".ci-artifacts/reports/vite-api-override.log": "typed refusal\n",
    ".ci-artifacts/reports/vitest.json": '{"numTotalTests":131}\n',
  };
  for (const [relative, body] of Object.entries(bodies)) {
    const path = join(fixture, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const source = { commit_oid: "1".repeat(40), tree_oid: "2".repeat(40) };
  const proofPath = ".ci-artifacts/reports/fast-source-proof.json";
  bodies[proofPath] = JSON.stringify(syntheticSourceProof("fast", source));
  writeFileSync(join(fixture, proofPath), bodies[proofPath]);
  const observation = {
    ...source,
    repository: "bullet-portal",
    outcomes: [{ lane: "fast", status: "PASS", exit_code: 0 }],
    artifact_hashes: Object.keys(bodies).map((relative) => ({
      path: relative,
      sha256: hash(join(fixture, relative)),
    })),
  };
  const path = join(fixture, ".ci-artifacts/observations/fast.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(observation) + "\n");
  return fixture;
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(`CI_STAGE_TEST_FAILED: ${message}`);
}

// Bootstrap refuses before lifecycle preparation: retain a typed diagnostic,
// never a success-shaped substitute for the missing proof and observation.
const diagnosticScript = resolve("ops/ci/refusal-diagnostic.mjs");
for (const mutation of ["none", "pass", "extra", "occupied", "symlink", "observation", "proof", "oversized"]) {
  const fixture = mkdtempSync(join(tmpdir(), "bullet-portal-refusal-"));
  try {
    const recorded = spawnSync(process.execPath, [diagnosticScript, "fast", "failure", "75", "91"], { cwd: fixture, encoding: "utf8" });
    assert(recorded.status === 0, `refusal writer failed: ${recorded.stderr}`);
    const path = join(fixture, ".ci-artifacts/diagnostics/fast-refusal.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (mutation === "pass") value.lane_outcome = "success";
    if (mutation === "extra") value.raw = "unexpected payload";
    if (["pass", "extra"].includes(mutation)) writeFileSync(path, JSON.stringify(value));
    if (mutation === "oversized") writeFileSync(path, " ".repeat(2049));
    if (mutation === "occupied") mkdirSync(join(fixture, "target/ci-upload/fast"), { recursive: true });
    if (mutation === "symlink") { rmSync(path); symlinkSync("/dev/null", path); }
    if (["observation", "proof"].includes(mutation)) {
      const other = join(fixture, mutation === "proof" ? ".ci-artifacts/reports/fast-source-proof.json" : ".ci-artifacts/observations/fast.json");
      mkdirSync(dirname(other), { recursive: true }); writeFileSync(other, "{}");
    }
    const staged = run(fixture);
    assert(mutation === "none" ? staged.status === 0 : staged.status !== 0, `refusal staging ${mutation}: ${staged.stderr}`);
    if (mutation === "none") {
      const stagedPath = join(fixture, "target/ci-upload/fast/diagnostics/fast-refusal.json");
      assert(readFileSync(stagedPath, "utf8") === readFileSync(path, "utf8"), "refusal bytes changed");
      assert(!existsSync(join(fixture, "target/ci-upload/fast/observations/fast.json")), "refusal fabricated observation");
      assert(!existsSync(join(fixture, "target/ci-upload/fast/reports/fast-source-proof.json")), "refusal fabricated source proof");
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
for (const blockedDiagnostic of [false, true]) {
  const fixture = mkdtempSync(join(tmpdir(), "bullet-portal-publisher-"));
  try {
    mkdirSync(join(fixture, "scripts")); mkdirSync(join(fixture, "ops/ci"), { recursive: true });
    copyFileSync("scripts/ci-observation.sh", join(fixture, "scripts/ci-observation.sh"));
    copyFileSync(diagnosticScript, join(fixture, "ops/ci/refusal-diagnostic.mjs"));
    writeFileSync(join(fixture, "ops/ci/observation.mjs"), 'console.error("fixture publisher refused"); process.exit(91);');
    if (blockedDiagnostic) symlinkSync("/dev/null", join(fixture, ".ci-artifacts"));
    const output = join(fixture, "github-output");
    const result = spawnSync("bash", ["scripts/ci-observation.sh", "fast", "failure", "75"], { cwd: fixture, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
    assert(result.status === 91 && result.stderr.includes("fixture publisher refused"), "diagnostic failure masked original publisher status");
    assert(!existsSync(output), "failed publisher advertised present observation");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
console.log("[ci] publication refusal diagnostics and original failure propagation passed");

await import("./observation-lifecycle-test.mjs");
