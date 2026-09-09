import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertExactManifest,
  BundleError,
  expectedManifestBytes,
  hashFile,
  hashToolDirectory,
  MANIFEST_NAME,
  readBounded,
  type ManifestInput,
  type SourceSubject,
  type ToolSubject,
} from "./bundle.ts";

const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;

function fail(code: string, message: string): never {
  throw new BundleError(code, message);
}

async function regularRealPath(candidate: string, label: string): Promise<string> {
  if (!path.isAbsolute(candidate)) fail("TOOL_SUBJECT_INVALID", `${label} path must be absolute`);
  const resolved = await realpath(candidate).catch(() => fail("TOOL_SUBJECT_INVALID", `${label} cannot be resolved`));
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("TOOL_SUBJECT_INVALID", `${label} must resolve to a regular file`);
  }
  return resolved;
}

export async function resolveExecutable(name: string, pathValue = process.env.PATH): Promise<string> {
  if (pathValue === undefined) fail("TOOL_SUBJECT_INVALID", "PATH is unavailable");
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0 || !path.isAbsolute(directory)) {
      fail("TOOL_SUBJECT_INVALID", "PATH contains an empty or relative component");
    }
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try {
        return await regularRealPath(candidate, name);
      } catch (error) {
        if (error instanceof BundleError && error.code !== "TOOL_SUBJECT_INVALID") throw error;
      }
    }
  }
  fail("TOOL_SUBJECT_INVALID", `${name} was not found on the admitted PATH`);
}

function runExact(executable: string, arguments_: string[], cwd: string, label: string): Buffer {
  const result = spawnSync(executable, arguments_, {
    cwd,
    encoding: "buffer",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: {
      HOME: path.join(os.tmpdir(), "bullet-portal-no-home"),
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "bullet-portal-no-global-config"),
      PATH: path.dirname(process.execPath),
    },
  });
  if (result.error !== undefined) fail("TOOL_EXECUTION_FAILED", `${label}: ${result.error.message}`);
  if (result.status !== 0 || result.signal !== null) {
    fail("TOOL_EXECUTION_FAILED", `${label} exited ${String(result.status)} signal ${String(result.signal)}`);
  }
  if (result.stderr.length !== 0) fail("TOOL_EXECUTION_FAILED", `${label} wrote to stderr`);
  return result.stdout;
}

function oneAsciiLine(bytes: Buffer, label: string): string {
  if (bytes.length === 0 || bytes.length > 512 || !bytes.every((byte) => byte === 10 || (byte >= 32 && byte <= 126))) {
    fail("TOOL_OUTPUT_INVALID", `${label} output is not one bounded ASCII line`);
  }
  const value = bytes.toString("ascii").replace(/\n$/u, "");
  if (value.length === 0 || value.includes("\n")) fail("TOOL_OUTPUT_INVALID", `${label} output is ambiguous`);
  return value;
}

async function toolSubject(
  name: ToolSubject["name"],
  executable: string,
  version: string,
  platform?: string,
  architecture?: string,
): Promise<ToolSubject> {
  const digest = await hashFile(executable, MAX_TOOL_BYTES);
  return { name, version, ...digest, ...(platform === undefined ? {} : { platform }), ...(architecture === undefined ? {} : { architecture }) };
}

function gitOutput(git: string, root: string, arguments_: string[], label: string): string {
  return oneAsciiLine(
    runExact(git, ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...arguments_], root, label),
    label,
  );
}

export async function readGitSubject(root: string, gitExecutable: string): Promise<SourceSubject> {
  const gitDirectory = await lstat(path.join(root, ".git")).catch(() => fail("SOURCE_AMBIGUOUS", ".git is missing"));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
    fail("SOURCE_AMBIGUOUS", "source must be a canonical checkout, not a linked worktree");
  }
  const topLevel = gitOutput(gitExecutable, root, ["rev-parse", "--show-toplevel"], "git top-level");
  if ((await realpath(topLevel)) !== (await realpath(root))) fail("SOURCE_AMBIGUOUS", "wrong Git top-level");
  const status = runExact(
    gitExecutable,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    root,
    "git status",
  );
  if (status.length !== 0) fail("DIRTY_SOURCE", "Portal source has tracked or untracked changes");
  const algorithm = gitOutput(gitExecutable, root, ["rev-parse", "--show-object-format"], "git object format");
  if (algorithm !== "sha1" && algorithm !== "sha256") fail("SOURCE_AMBIGUOUS", "unsupported Git object format");
  const width = algorithm === "sha1" ? 40 : 64;
  const commit = gitOutput(gitExecutable, root, ["rev-parse", "--verify", "HEAD^{commit}"], "git commit");
  const tree = gitOutput(gitExecutable, root, ["rev-parse", "--verify", "HEAD^{tree}"], "git tree");
  const oidPattern = new RegExp(`^[0-9a-f]{${width}}$`, "u");
  if (!oidPattern.test(commit) || !oidPattern.test(tree)) fail("SOURCE_AMBIGUOUS", "Git returned a malformed OID");
  return { repository: "bullet-portal", commit_oid: `${algorithm}:${commit}`, tree_oid: `${algorithm}:${tree}` };
}

export async function readToolSubjects(root: string, gitExecutable?: string): Promise<ToolSubject[]> {
  const node = await regularRealPath(process.execPath, "node");
  const npmEnvironment = process.env.npm_execpath;
  if (npmEnvironment === undefined) fail("TOOL_SUBJECT_INVALID", "run through an exact npm script");
  const npm = await regularRealPath(npmEnvironment, "npm");
  const npmRoot = path.dirname(path.dirname(npm));
  if (path.relative(npmRoot, npm).split(path.sep).join("/") !== "bin/npm-cli.js") {
    fail("TOOL_SUBJECT_INVALID", "npm entrypoint is not the package's bin/npm-cli.js");
  }
  const git = gitExecutable ?? (await resolveExecutable("git"));
  const nodeVersion = process.version;
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion)) fail("TOOL_SUBJECT_INVALID", "Node version is not exact");
  const npmVersion = oneAsciiLine(runExact(node, [npm, "--version"], root, "npm version"), "npm version");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(npmVersion)) fail("TOOL_SUBJECT_INVALID", "npm version is not exact");
  const gitVersion = gitOutput(git, root, ["--version"], "git version");
  if (!/^git version [0-9]+\.[0-9]+\.[0-9]+(?:[.][0-9]+)?$/.test(gitVersion)) {
    fail("TOOL_SUBJECT_INVALID", "Git version is not exact");
  }
  return Promise.all([
    toolSubject("git", git, gitVersion),
    toolSubject("node", node, nodeVersion, process.platform, process.arch),
    hashToolDirectory(npmRoot).then((digest) => ({ name: "npm" as const, version: npmVersion, ...digest })),
  ]);
}

async function manifestInput(root: string): Promise<ManifestInput> {
  const git = await resolveExecutable("git");
  const source = await readGitSubject(root, git);
  const tools = await readToolSubjects(root, git);
  return {
    source,
    tools,
    packageLockPath: path.join(root, "package-lock.json"),
    distPath: path.join(root, "dist"),
  };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishManifest(target: string, bytes: Buffer): Promise<void> {
  try {
    assertExactManifest(await readBounded(target), bytes);
    return;
  } catch (error) {
    if (!(error instanceof BundleError) || error.code !== "FILE_OPEN_FAILED") throw error;
  }
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${MANIFEST_NAME}.${process.pid}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assertExactManifest(await readBounded(target), bytes);
    }
    await unlink(temporary);
    await syncDirectory(directory);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function run(command: "generate" | "check", root = process.cwd()): Promise<void> {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root)) fail("SOURCE_AMBIGUOUS", "repository root traverses a symlink");
  const input = await manifestInput(canonicalRoot);
  const expected = await expectedManifestBytes(input);
  const target = path.join(input.distPath, MANIFEST_NAME);
  if (command === "generate") {
    await publishManifest(target, expected);
  } else {
    assertExactManifest(await readBounded(target), expected);
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || (process.argv[2] !== "generate" && process.argv[2] !== "check")) {
    fail("USAGE", "usage: portal-bundle <generate|check>");
  }
  await run(process.argv[2]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof BundleError) {
      process.stderr.write(`portal-bundle: ${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write("portal-bundle: INTERNAL_ERROR\n");
    }
    process.exitCode = 1;
  });
}
