import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  admitBundlePath,
  assertExactManifest,
  blake3Bytes,
  BundleError,
  createManifest,
  expectedManifestBytes,
  hashToolDirectory,
  MANIFEST_NAME,
  type ManifestInput,
  type ToolSubject,
  validateRecords,
} from "./bundle.ts";
import { readGitSubject, resolveExecutable, run } from "./portal-bundle.ts";

const encoder = new TextEncoder();
const source = {
  repository: "bullet-portal" as const,
  commit_oid: `sha1:${"a".repeat(40)}`,
  tree_oid: `sha1:${"b".repeat(40)}`,
};

function tool(name: ToolSubject["name"], marker: string = name): ToolSubject {
  return {
    name,
    version: name === "git" ? "git version 2.50.1" : name === "node" ? "v26.1.0" : "11.13.0",
    size: marker.length,
    blake3: blake3Bytes(encoder.encode(marker)),
    ...(name === "node" ? { platform: "linux", architecture: "x64" } : {}),
    ...(name === "npm" ? { file_count: 1 } : {}),
  };
}

async function fixture(t: test.TestContext): Promise<{ root: string; input: ManifestInput }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bullet-portal-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<main>Bullet Farm</main>\n");
  await writeFile(path.join(root, "dist", "assets", "app.js"), "console.log('farm');\n");
  await writeFile(path.join(root, "dist", "assets", "app.css"), "body{color:#123}\n");
  await writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  return {
    root,
    input: {
      source,
      tools: [tool("npm"), tool("git"), tool("node")],
      packageLockPath: path.join(root, "package-lock.json"),
      distPath: path.join(root, "dist"),
    },
  };
}

function expectBundleError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof BundleError && error.code === code);
}

async function expectBundleRejection(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof BundleError && error.code === code);
}

function exactGit(git: string, cwd: string, arguments_: string[]): void {
  const result = spawnSync(git, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `git ${arguments_.join(" ")}: ${result.stderr}`);
}

async function committedFixture(t: test.TestContext): Promise<{ root: string; git: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bullet-portal-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = await resolveExecutable("git");
  exactGit(git, root, ["init", "--quiet"]);
  await writeFile(path.join(root, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  await writeFile(path.join(root, "source.txt"), "exact source\n");
  exactGit(git, root, ["add", ".gitignore", "package-lock.json", "source.txt"]);
  exactGit(git, root, [
    "-c",
    "user.name=Bundle Test",
    "-c",
    "user.email=bundle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<main>exact</main>\n");
  await writeFile(path.join(root, "dist", "assets", "app.js"), "console.log('exact');\n");
  return { root, git };
}

test("BLAKE3 vectors and manifest bytes are deterministic and canonically ordered", async (t) => {
  assert.equal(
    blake3Bytes(new Uint8Array()),
    "blake3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
  );
  const { input } = await fixture(t);
  const first = await createManifest(input);
  const second = await createManifest(input);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.files.map((record) => record.path),
    ["assets/app.css", "assets/app.js", "index.html"],
  );
  assert.deepEqual(first.tools.map((subject) => subject.name), ["git", "node", "npm"]);
  assert.deepEqual(await expectedManifestBytes(input), await expectedManifestBytes(input));
});

test("content, membership, name, lock, and tool mutations invalidate the exact manifest", async (t) => {
  async function expectDrift(mutate: (root: string) => Promise<void>): Promise<void> {
    const { root, input } = await fixture(t);
    const before = await expectedManifestBytes(input);
    await mutate(root);
    const after = await expectedManifestBytes(input);
    expectBundleError(() => assertExactManifest(before, after), "BUNDLE_MANIFEST_DRIFT");
  }

  await expectDrift((root) => writeFile(path.join(root, "dist", "assets", "app.js"), "console.log('farM');\n"));
  await expectDrift((root) => writeFile(path.join(root, "dist", "assets", "extra.js"), "export {};\n"));
  await expectDrift((root) => unlink(path.join(root, "dist", "assets", "app.css")));
  await expectDrift((root) =>
    rename(path.join(root, "dist", "assets", "app.js"), path.join(root, "dist", "assets", "renamed.js")),
  );
  await expectDrift((root) => writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":2}\n"));

  const { input } = await fixture(t);
  const before = await expectedManifestBytes(input);
  input.tools = input.tools.map((subject) => (subject.name === "npm" ? tool("npm", "substituted npm") : subject));
  const after = await expectedManifestBytes(input);
  expectBundleError(() => assertExactManifest(before, after), "BUNDLE_MANIFEST_DRIFT");

  const npmRoot = await mkdtemp(path.join(os.tmpdir(), "bullet-portal-npm-subject-"));
  t.after(() => rm(npmRoot, { recursive: true, force: true }));
  await mkdir(path.join(npmRoot, "bin"));
  await mkdir(path.join(npmRoot, "lib"));
  await writeFile(path.join(npmRoot, "bin", "npm-cli.js"), "import '../lib/cli.js';\n");
  await writeFile(path.join(npmRoot, "lib", "cli.js"), "export const value = 1;\n");
  const firstTool = await hashToolDirectory(npmRoot);
  await writeFile(path.join(npmRoot, "lib", "cli.js"), "export const value = 2;\n");
  const substitutedTool = await hashToolDirectory(npmRoot);
  assert.equal(substitutedTool.file_count, firstTool.file_count);
  assert.equal(substitutedTool.size, firstTool.size);
  assert.notEqual(substitutedTool.blake3, firstTool.blake3);
});

test("hostile paths, duplicates, portable collisions, symlinks, and unexpected files fail closed", async (t) => {
  for (const hostile of [
    "",
    "/index.html",
    "../index.html",
    "assets/../index.html",
    "assets\\app.js",
    "assets/.git",
    "assets/app.js:stream",
    "assets/app.js.",
    "assets/app.js ",
    "assets/app\0.js",
    "assets/e\u0301.js",
  ]) {
    expectBundleError(() => admitBundlePath(hostile), "INVALID_BUNDLE_PATH");
  }
  for (const unexpected of ["other/app.js", "assets/app.map"]) {
    expectBundleError(() => admitBundlePath(unexpected), "UNEXPECTED_BUNDLE_ENTRY");
  }

  const digest = blake3Bytes(encoder.encode("same"));
  const index = { path: "index.html", size: 1, mime: "text/html; charset=utf-8", blake3: digest };
  expectBundleError(() => validateRecords([index, index]), "DUPLICATE_BUNDLE_PATH");
  expectBundleError(
    () =>
      validateRecords([
        index,
        { path: "assets/App.js", size: 1, mime: "text/javascript; charset=utf-8", blake3: digest },
        { path: "assets/app.js", size: 1, mime: "text/javascript; charset=utf-8", blake3: digest },
      ]),
    "PORTABLE_PATH_COLLISION",
  );

  const symlinkFixture = await fixture(t);
  await symlink(path.join(symlinkFixture.root, "dist", "assets", "app.js"), path.join(symlinkFixture.root, "dist", "assets", "link.js"));
  await expectBundleRejection(() => createManifest(symlinkFixture.input), "SYMLINK_REJECTED");

  const unexpectedFixture = await fixture(t);
  await writeFile(path.join(unexpectedFixture.root, "dist", "robots.txt"), "unexpected\n");
  await expectBundleRejection(() => createManifest(unexpectedFixture.input), "UNEXPECTED_BUNDLE_ENTRY");

  const collisionFixture = await fixture(t);
  await writeFile(path.join(collisionFixture.root, "dist", "assets", "App.js"), "case\n");
  await expectBundleRejection(() => createManifest(collisionFixture.input), "PORTABLE_PATH_COLLISION");
});

test("Git source admission rejects tracked, untracked, and linked-worktree ambiguity", async (t) => {
  const { root, git } = await committedFixture(t);
  const clean = await readGitSubject(root, git);
  assert.match(clean.commit_oid, /^sha1:[0-9a-f]{40}$/u);
  assert.match(clean.tree_oid, /^sha1:[0-9a-f]{40}$/u);

  await writeFile(path.join(root, "source.txt"), "dirty source\n");
  await expectBundleRejection(() => readGitSubject(root, git), "DIRTY_SOURCE");
  await writeFile(path.join(root, "source.txt"), "exact source\n");
  await writeFile(path.join(root, "untracked.txt"), "untracked\n");
  await expectBundleRejection(() => readGitSubject(root, git), "DIRTY_SOURCE");
  await unlink(path.join(root, "untracked.txt"));

  const linked = await mkdtemp(path.join(os.tmpdir(), "bullet-portal-linked-"));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await writeFile(path.join(linked, ".git"), `gitdir: ${path.join(root, ".git")}\n`);
  await expectBundleRejection(() => readGitSubject(linked, git), "SOURCE_AMBIGUOUS");
});

test("generate/check is idempotent and detects post-generation drift", async (t) => {
  const { root } = await committedFixture(t);
  await run("generate", root);
  const manifestPath = path.join(root, "dist", MANIFEST_NAME);
  const first = await readFile(manifestPath);
  await run("generate", root);
  assert.deepEqual(await readFile(manifestPath), first);
  await run("check", root);

  await writeFile(path.join(root, "dist", "assets", "app.js"), "console.log('changed');\n");
  await expectBundleRejection(() => run("check", root), "BUNDLE_MANIFEST_DRIFT");
  await unlink(manifestPath);
  await symlink(path.join(root, "source.txt"), manifestPath);
  await expectBundleRejection(() => run("generate", root), "FILE_OPEN_FAILED");
});
