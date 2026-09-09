import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
  const observation = {
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
