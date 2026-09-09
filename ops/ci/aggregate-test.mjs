import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateRequiredRun } from "./aggregate.mjs";

const lanes = ["fast", "lint", "contract", "security", "docs"];
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const successfulNeeds = Object.fromEntries(
  lanes.map((lane) => [lane, { result: "success", outputs: { observation: "true" } }]),
);
const artifactsByLane = {
  fast: { ".ci-artifacts/reports/vitest.json": '{"numTotalTests":131}\n' },
  lint: {},
  contract: { ".ci-artifacts/reports/playwright.xml": '<testsuites tests="14"/>\n' },
  security: {},
  docs: {},
};

const first = makeFixture();
try {
  assert.deepEqual(validateRequiredRun(first, commit, successfulNeeds), lanes);
} finally {
  rmSync(first, { recursive: true, force: true });
}

scenario("failed predecessor", "REQUIRED_JOB_NOT_SUCCESSFUL", (_root, needs) => {
  needs.fast.result = "failure";
});
scenario("missing observation output", "MISSING_CI_OBSERVATION", (_root, needs) => {
  needs.security.outputs = {};
});
scenario("missing observation file", "CI_OBSERVATION_MISSING", (root) => {
  rmSync(join(root, "observations/docs.json"));
});
scenario("wrong repository", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "lint", (value) => (value.repository = "somewhere-else"));
});
scenario("wrong commit", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "security", (value) => (value.commit_oid = "2".repeat(40)));
});
scenario("wrong tree", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "security", (value) => {
    const replacement = value.tree_oid.startsWith("0") ? "1" : "0";
    value.tree_oid = `${replacement}${value.tree_oid.slice(1)}`;
  });
});
scenario("dirty subject", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "docs", (value) => (value.clean = false));
});
scenario("non-PASS outcome", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "contract", (value) => {
    value.outcomes = [{ lane: "contract", status: "FAIL", exit_code: 1 }];
  });
});
scenario("wrong lane outcome", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "fast", (value) => (value.outcomes[0].lane = "docs"));
});
scenario("unexpected field", "CI_OBSERVATION_INVALID", (root) => {
  mutateObservation(root, "fast", (value) => (value.untrusted = true));
});
scenario("malformed JSON", "CI_OBSERVATION_INVALID", (root) => {
  writeFileSync(join(root, "observations/lint.json"), "{");
});
scenario("duplicate artifact binding", "CI_ARTIFACT_DUPLICATE", (root) => {
  mutateObservation(root, "contract", (value) => {
    value.artifact_hashes[0].path = ".ci-artifacts/reports/vitest.json";
    value.artifact_hashes[0].sha256 = hash(join(root, "reports/vitest.json"));
  });
});
scenario("artifact traversal", "CI_ARTIFACT_PATH_INVALID", (root) => {
  mutateObservation(root, "fast", (value) => {
    value.artifact_hashes[0].path = ".ci-artifacts/../escape";
  });
});
scenario("missing artifact", "CI_ARTIFACT_MISSING", (root) => {
  rmSync(join(root, "reports/vitest.json"));
});
scenario("tampered artifact", "CI_ARTIFACT_HASH_MISMATCH", (root) => {
  writeFileSync(join(root, "reports/playwright.xml"), "tampered\n");
});
scenario("unbound extra artifact", "CI_ARTIFACT_INVENTORY_INVALID", (root) => {
  writeFile(root, "reports/unbound.txt", "not in any observation\n");
});
scenario("unexpected observation", "CI_ARTIFACT_INVENTORY_INVALID", (root) => {
  writeFile(root, "observations/unknown.json", "{}\n");
});
scenario("symlinked artifact", "CI_ARTIFACT_SYMLINK_REJECTED", (root) => {
  const path = join(root, "reports/vitest.json");
  const target = join(root, "outside.txt");
  writeFileSync(target, '{"numTotalTests":131}\n');
  rmSync(path);
  symlinkSync(target, path);
  mutateObservation(root, "fast", (value) => {
    value.artifact_hashes[0].sha256 = hash(target);
  });
});

console.log("[ci] required aggregation hostile matrix passed (18 refusals)");

function scenario(name, expectedCode, mutate) {
  const root = makeFixture();
  const needs = structuredClone(successfulNeeds);
  try {
    mutate(root, needs);
    assert.throws(
      () => validateRequiredRun(root, commit, needs),
      new RegExp(`${expectedCode}:`),
      name,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "bullet-portal-aggregate-"));
  for (const [lane, artifacts] of Object.entries(artifactsByLane)) {
    for (const [path, body] of Object.entries(artifacts)) {
      writeFile(root, path.slice(".ci-artifacts/".length), body);
    }
    const artifactHashes = Object.keys(artifacts).map((path) => ({
      path,
      sha256: hash(join(root, path.slice(".ci-artifacts/".length))),
    }));
    writeFile(
      root,
      `observations/${lane}.json`,
      `${JSON.stringify({
        schema_version: "bullet.ci-observation.v1",
        repository: "bullet-portal",
        commit_oid: commit,
        tree_oid: tree,
        clean: true,
        commands: [`bash scripts/ci-local.sh ${lane}`],
        tool_versions: { node: "v22.23.2", npm: "10.9.8" },
        outcomes: [{ lane, status: "PASS", exit_code: 0 }],
        artifact_hashes: artifactHashes,
        signed: false,
        evidence_class: "DIAGNOSTIC_ONLY",
      })}\n`,
    );
  }
  return root;
}

function mutateObservation(root, lane, mutate) {
  const path = join(root, `observations/${lane}.json`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeFile(root, relative, contents) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
