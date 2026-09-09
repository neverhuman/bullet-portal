import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";

type Reject = (detail: string) => never;
const MAX_DECLARATION_BYTES = 512 * 1024;
const MAX_LINK_BYTES = 512;

function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function realEntry(root: string, relative: string, file: boolean, reject: Reject): Promise<Stats> {
  let current = root;
  const parts = relative.split("/");
  let metadata = await lstat(root);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    metadata = await lstat(current).catch(() => reject("npm bin target or declaration is missing"));
    const finalFile = file && index === parts.length - 1;
    if (metadata.isSymbolicLink() || (finalFile ? !metadata.isFile() : !metadata.isDirectory())) {
      reject("npm bin targets and declarations must have real directory ancestors and regular leaves");
    }
  }
  return metadata;
}

async function declaration(root: string, relative: string, reject: Reject): Promise<Record<string, unknown>> {
  const before = await realEntry(root, relative, true, reject);
  if (before.nlink !== 1 || before.size <= 0 || before.size > MAX_DECLARATION_BYTES) {
    reject("npm bin declaration is linked, empty or oversized");
  }
  const handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => reject("npm bin declaration cannot be opened"));
  try {
    if (!same(before, await handle.stat())) reject("npm bin declaration changed before read");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) reject("npm bin declaration was truncated");
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0 ||
      !same(before, await handle.stat()) || !same(before, await lstat(path.join(root, relative)))) {
      reject("npm bin declaration changed during read");
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { reject("npm bin declaration is invalid JSON"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      reject("npm bin declaration must be an object");
    }
    return value as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

// Only npm's direct dependency .bin links are qualified. No link is followed.
// Both the literal link and declared regular target remain part of the tree hash.
export async function readNpmBinLink(root: string, relative: string, reject: Reject): Promise<string> {
  const match = /^node_modules\/\.bin\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(relative);
  if (match === null) reject(`npm package link is outside the qualified .bin layout: ${relative}`);
  if (await realpath(root) !== path.resolve(root)) reject("npm package root traverses a symlink");
  await realEntry(root, "node_modules/.bin", false, reject);
  const absolute = path.join(root, relative);
  const before = await lstat(absolute);
  if (!before.isSymbolicLink() || before.size <= 0 || before.size > MAX_LINK_BYTES) {
    reject("npm bin link is missing, substituted or oversized");
  }
  const bytes = await readlink(absolute, { encoding: "buffer" });
  if (bytes.length !== before.size || !bytes.every((byte) => byte >= 32 && byte <= 126)) {
    reject("npm bin link is not bounded ASCII");
  }
  const target = bytes.toString("ascii");
  const destination = /^\.\.\/((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)\/(.+)$/u.exec(target);
  if (destination === null || path.posix.normalize(target) !== target || target.includes("\\")) {
    reject("npm bin link must name a canonical relative sibling-package target");
  }
  const packageName = destination[1];
  const packageRoot = `node_modules/${packageName}`;
  const manifest = await declaration(root, `${packageRoot}/package.json`, reject);
  if (manifest.name !== packageName) reject("npm bin package name does not match its directory");
  const bins = manifest.bin;
  const command = match[1];
  const selected = typeof bins === "string" && command === packageName.split("/").at(-1)
    ? bins : bins !== null && typeof bins === "object" && !Array.isArray(bins) && Object.hasOwn(bins, command)
      ? (bins as Record<string, unknown>)[command] : undefined;
  if (typeof selected !== "string" || selected.length === 0 || selected.length > MAX_LINK_BYTES) {
    reject("npm bin command is not declared by its target package");
  }
  const declared = selected.replace(/^\.\//u, "");
  if (!/^[A-Za-z0-9_./-]+$/u.test(declared) || declared.startsWith("/") ||
    declared.split("/").some((part) => part === "" || part === "." || part === "..")) {
    reject("npm bin declaration has an unsafe target");
  }
  const expected = path.posix.relative("node_modules/.bin", `${packageRoot}/${declared}`);
  if (target !== expected) reject("npm bin link differs from its declared target");
  const targetMetadata = await realEntry(root, `${packageRoot}/${declared}`, true, reject);
  if (targetMetadata.nlink !== 1) reject("npm bin target has ambiguous hardlink custody");
  if (!same(before, await lstat(absolute)) || !bytes.equals(await readlink(absolute, { encoding: "buffer" }))) {
    reject("npm bin link changed during inspection");
  }
  return target;
}
