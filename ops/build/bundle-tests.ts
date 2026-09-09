import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  const legacyRecords = [
    { blake3: blake3Bytes(encoder.encode("import '../lib/cli.js';\n")), path: "bin/npm-cli.js", size: 24 },
    { blake3: blake3Bytes(encoder.encode("export const value = 1;\n")), path: "lib/cli.js", size: 24 },
  ];
  assert.equal(firstTool.blake3, blake3Bytes(encoder.encode(`bullet.portal.tool-tree.v1\0${JSON.stringify(legacyRecords)}`)));
  await npmLinkPairs(t, input);
});

async function npmLinkPairs(t: test.TestContext, input: ManifestInput): Promise<void> {
  async function linked(modules = "node_modules"): Promise<{ root: string; link: string; target: string; manifest: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "bullet-npm-links-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, modules, ".bin"), { recursive: true });
    await mkdir(path.join(root, modules, "@npmcli/arborist/bin"), { recursive: true });
    const manifest = path.join(root, modules, "@npmcli/arborist/package.json");
    await writeFile(manifest, JSON.stringify({ name: "@npmcli/arborist", bin: { arborist: "bin/index.js" } }));
    const target = path.join(root, modules, "@npmcli/arborist/bin/index.js");
    await writeFile(target, "#!/usr/bin/env node\n");
    const link = path.join(root, modules, ".bin/arborist");
    await symlink("../@npmcli/arborist/bin/index.js", link);
    return { root, link, target, manifest };
  }
  const valid = await linked();
  const first = await hashToolDirectory(valid.root);
  assert.deepEqual(await hashToolDirectory(valid.root), first);
  assert.equal(first.file_count, 3); // declaration, regular target and literal link
  input.tools = [tool("git"), tool("node"), { name: "npm", version: "10.9.8", ...first }];
  const manifest = await expectedManifestBytes(input);
  await writeFile(valid.target, "#!/usr/bin/env nodE\n");
  const changed = await hashToolDirectory(valid.root);
  assert.equal(changed.size, first.size);
  assert.notEqual(changed.blake3, first.blake3);
  input.tools[2] = { name: "npm", version: "10.9.8", ...changed };
  const changedManifest = await expectedManifestBytes(input);
  expectBundleError(() => assertExactManifest(manifest, changedManifest), "BUNDLE_MANIFEST_DRIFT");
  await unlink(valid.link);
  await writeFile(valid.link, "../@npmcli/arborist/bin/index.js");
  const replacedLink = await hashToolDirectory(valid.root);
  assert.equal(replacedLink.size, changed.size);
  assert.equal(replacedLink.file_count, changed.file_count);
  assert.notEqual(replacedLink.blake3, changed.blake3);
  input.tools[2] = { name: "npm", version: "10.9.8", ...replacedLink };
  const replacedManifest = await expectedManifestBytes(input);
  expectBundleError(() => assertExactManifest(changedManifest, replacedManifest), "BUNDLE_MANIFEST_DRIFT");
  for (const invalid of ["dangling", "absolute", "escape", "cycle", "undeclared", "wrong-target", "wrong-name",
    "malformed", "unsafe-declaration", "target-link", "directory-link", "unrelated-link", "noncanonical",
    "external", "hardlinked-target", "hardlinked-declaration", "missing-declaration", "oversized-link", "oversized-declaration"] as const) {
    const fixture = await linked();
    switch (invalid) {
      case "dangling": await unlink(fixture.target); break;
      case "absolute":
      case "escape":
      case "cycle":
      case "wrong-target":
      case "noncanonical": {
        await unlink(fixture.link);
        const target = invalid === "absolute" ? fixture.target : invalid === "escape" ? "../../../outside.js"
          : invalid === "cycle" ? "arborist" : invalid === "noncanonical" ? "../@npmcli/arborist/bin/./index.js"
            : "../@npmcli/arborist/bin/other.js";
        if (invalid === "wrong-target") await writeFile(path.join(path.dirname(fixture.target), "other.js"), "safe\n");
        await symlink(target, fixture.link);
        break;
      }
      case "undeclared": await rename(fixture.link, path.join(path.dirname(fixture.link), "other")); break;
      case "wrong-name": await writeFile(fixture.manifest, JSON.stringify({ name: "other", bin: { arborist: "bin/index.js" } })); break;
      case "malformed": await writeFile(fixture.manifest, "{"); break;
      case "unsafe-declaration":
        await writeFile(fixture.manifest, JSON.stringify({ name: "@npmcli/arborist", bin: { arborist: "bin/../bin/index.js" } }));
        break;
      case "target-link":
        await rename(fixture.target, `${fixture.target}.real`);
        await symlink("index.js.real", fixture.target);
        break;
      case "directory-link":
        await rename(path.dirname(fixture.target), `${path.dirname(fixture.target)}-real`);
        await symlink("bin-real", path.dirname(fixture.target), "dir");
        break;
      case "unrelated-link": await symlink("node_modules/@npmcli/arborist/bin/index.js", path.join(fixture.root, "other")); break;
      case "external": {
        const outside = await mkdtemp(path.join(os.tmpdir(), "bullet-npm-outside-"));
        t.after(() => rm(outside, { recursive: true, force: true }));
        await writeFile(path.join(outside, "cli.js"), "external bytes\n");
        await unlink(fixture.link);
        await symlink(path.relative(path.dirname(fixture.link), path.join(outside, "cli.js")), fixture.link);
        break;
      }
      case "hardlinked-target": await link(fixture.target, `${fixture.target}.alias`); break;
      case "hardlinked-declaration": await link(fixture.manifest, `${fixture.manifest}.alias`); break;
      case "missing-declaration": await unlink(fixture.manifest); break;
      case "oversized-link":
        await unlink(fixture.link);
        await symlink(`../@npmcli/arborist/${"x".repeat(513)}`, fixture.link);
        break;
      case "oversized-declaration": await writeFile(fixture.manifest, " ".repeat(512 * 1024 + 1)); break;
    }
    await expectBundleRejection(() => hashToolDirectory(fixture.root), "TOOL_SUBJECT_INVALID");
  }
  const stringBin = await linked();
  await unlink(stringBin.link);
  await mkdir(path.join(stringBin.root, "node_modules/node-gyp/bin"), { recursive: true });
  await writeFile(path.join(stringBin.root, "node_modules/node-gyp/package.json"), JSON.stringify({ name: "node-gyp", bin: "./bin/node-gyp.js" }));
  await writeFile(path.join(stringBin.root, "node_modules/node-gyp/bin/node-gyp.js"), "safe\n");
  await symlink("../node-gyp/bin/node-gyp.js", path.join(stringBin.root, "node_modules/.bin/node-gyp"));
  assert.equal((await hashToolDirectory(stringBin.root)).file_count, 5);
  for (const modules of ["node_modules/@npmcli/metavuln-calculator/node_modules",
    "node_modules/outer/node_modules/@scope/inner/node_modules"]) {
    const nested = await linked(modules);
    const before = await hashToolDirectory(nested.root);
    assert.equal(before.file_count, 3);
    assert.deepEqual(await hashToolDirectory(nested.root), before);
    await writeFile(nested.target, "#!/usr/bin/env nodE\n");
    assert.notEqual((await hashToolDirectory(nested.root)).blake3, before.blake3);
    await unlink(nested.link);
    await symlink("../../../../outside.js", nested.link);
    await expectBundleRejection(() => hashToolDirectory(nested.root), "TOOL_SUBJECT_INVALID");
  }
  for (const modules of ["other/node_modules", "node_modules/node_modules",
    "node_modules/outer/lib/node_modules"]) {
    const invalidNamespace = await linked(modules);
    await expectBundleRejection(() => hashToolDirectory(invalidNamespace.root), "TOOL_SUBJECT_INVALID");
  }
}

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
