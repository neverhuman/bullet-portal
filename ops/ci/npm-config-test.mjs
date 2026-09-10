// Actual admitted npm execution; the only synthetic authority is for the
// disposable fixture. This cannot qualify a canonical proof or hosted runner.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, copySources, selected } from "./source-custody-fixture.mjs";

const origin = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "bullet-npm-config-"));
const repo = join(temporary, "repo");
const npm = selected("npm");
const results = [];
let succeeded = false;
try {
  assert.equal(process.version, "v22.23.2", "actual qualified Node required");
  const version = spawnSync(npm, ["--version"], { encoding: "utf8", env: {
    ...process.env, NPM_CONFIG_USERCONFIG: join(origin, "ops/ci/npm-userconfig.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(origin, "ops/ci/npm-globalconfig.npmrc"),
  } });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "10.9.8", "actual qualified npm required");
  results.push("actual pinned Node and npm");

  const duplicate = spawnSync(npm, ["--version"], { encoding: "utf8", env: {
    ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null",
  } });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /double-loading config "\/dev\/null"/);
  results.push("original duplicate config refusal reproduced");

  mkdirSync(repo);
  copySources(origin, repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: "pipe",
  });
  git("-c", "init.templateDir=", "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, ".gitignore"), "/.ci-artifacts/\n");
  writeFileSync(join(repo, "ops/ci/fast.sh"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p .ci-artifacts/reports .ci-artifacts/npm-init
[[ "$(node --version)" == v22.23.2 && "$(npm --version)" == 10.9.8 ]]
[[ "$(npm config get userconfig)" == "$PWD/ops/ci/npm-userconfig.npmrc" ]]
[[ "$(npm config get globalconfig)" == "$PWD/ops/ci/npm-globalconfig.npmrc" ]]
[[ "$(npm config get registry)" == https://registry.npmjs.org/ ]]
[[ "$(npm config get init-author-name)" == "" ]]
cd .ci-artifacts/npm-init
npm init --yes --ignore-scripts >../reports/npm-init.log
cd ../..
node -e 'const p=JSON.parse(require("node:fs").readFileSync(".ci-artifacts/npm-init/package.json")); if(p.author !== "") throw new Error("ambient author leaked")'
for name in vitest.json vite-api-override.log farmd-test-proxy-override.log; do printf 'diagnostic fixture\\n' >.ci-artifacts/reports/$name; done
`);
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "npm config fixture");
  process.env.BULLET_CI_FIXTURE_ROOT = temporary;
  const admission = admit(repo, ["fast"], ["npm"]);
  const poison = join(temporary, "ambient.npmrc");
  writeFileSync(poison, "registry=https://hostile.invalid/\ninit-author-name=ambient-poison\n");
  const outcome = spawnSync("bash", ["scripts/ci-local.sh", "fast"], { cwd: repo,
    encoding: "utf8", timeout: 60_000, env: { ...process.env,
      PATH: admission.tool_path, BULLET_CI_SOURCE_ADMISSION: admission.path,
      BULLET_CI_SOURCE_ADMISSION_SHA256: admission.sha256,
      NPM_CONFIG_USERCONFIG: poison, NPM_CONFIG_GLOBALCONFIG: poison,
      npm_config_userconfig: poison, npm_config_globalconfig: poison,
      NPM_CONFIG_CACHE: join(repo, ".ci-artifacts/npm-cache"),
    } });
  writeFileSync(join(temporary, "wrapper.log"), outcome.stdout + outcome.stderr);
  assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr);
  const observation = JSON.parse(readFileSync(join(repo, ".ci-artifacts/observations/fast.json")));
  assert.equal(observation.tool_versions.npm, "10.9.8");
  assert.equal(observation.outcomes[0].status, "PASS");
  const configured = JSON.parse(readFileSync(admission.path));
  assert.equal(configured.tools.find((tool) => tool.name === "npm").path, npm);
  results.push("wrapper ignores uppercase and lowercase ambient config selectors");
  results.push("real npm version config queries and offline init complete under live monitor");
  succeeded = true;
} finally {
  if (succeeded) {
    rmSync(temporary, { recursive: true });
    console.log(`[ci] npm config isolation passed (${results.length} cases)`);
  } else console.error(`[ci] retained failed npm config fixture ${temporary}`);
}
