import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { constants } from "node:fs";
import { open, readdir, lstat } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_NAME = ".bullet-portal-bundle-v1.json";
const ROOT_DOMAIN = "bullet.portal.bundle.root.v1";
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_TREE_FILES = 4_096;
const MAX_TOOL_TREE_BYTES = 128 * 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

export class BundleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

export interface SourceSubject {
  repository: "bullet-portal";
  commit_oid: string;
  tree_oid: string;
}

export interface ToolSubject {
  name: "git" | "node" | "npm";
  version: string;
  size: number;
  blake3: string;
  platform?: string;
  architecture?: string;
  file_count?: number;
}

export interface FileRecord {
  path: string;
  size: number;
  mime: string;
  blake3: string;
}

export interface BundleManifest {
  schema_version: "bullet.portal.bundle.v1";
  source: SourceSubject;
  package_lock: { path: "package-lock.json"; size: number; blake3: string };
  tools: ToolSubject[];
  files: FileRecord[];
  total_size: number;
  root: string;
}

export interface ManifestInput {
  source: SourceSubject;
  tools: ToolSubject[];
  packageLockPath: string;
  distPath: string;
}

function fail(code: string, message: string): never {
  throw new BundleError(code, message);
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function validateDigest(value: string, field: string): void {
  if (!/^blake3:[0-9a-f]{64}$/.test(value)) {
    fail("INVALID_SUBJECT", `${field} must be a full lowercase BLAKE3 digest`);
  }
}

function validateOid(value: string, field: string): void {
  if (!/^(sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/.test(value)) {
    fail("INVALID_SUBJECT", `${field} must be an algorithm-tagged Git OID`);
  }
}

export function admitBundlePath(relative: string): string {
  if (relative.length === 0 || Buffer.byteLength(relative, "utf8") > 240) {
    fail("INVALID_BUNDLE_PATH", "bundle path is empty or oversized");
  }
  if (relative !== relative.normalize("NFC")) {
    fail("INVALID_BUNDLE_PATH", `bundle path is not NFC: ${JSON.stringify(relative)}`);
  }
  if (
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.includes(":") ||
    /[\u0000-\u001f\u007f]/u.test(relative)
  ) {
    fail("INVALID_BUNDLE_PATH", `bundle path has forbidden syntax: ${JSON.stringify(relative)}`);
  }
  const components = relative.split("/");
  for (const component of components) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      component.startsWith(".") ||
      /[. ]$/u.test(component) ||
      asciiLower(component) === ".git"
    ) {
      fail("INVALID_BUNDLE_PATH", `bundle path has forbidden component: ${JSON.stringify(relative)}`);
    }
  }
  if (relative !== "index.html" && !(components.length === 2 && components[0] === "assets")) {
    fail("UNEXPECTED_BUNDLE_ENTRY", `unexpected bundle path: ${relative}`);
  }
  const extension = path.posix.extname(relative);
  const mime = MIME_BY_EXTENSION[extension];
  if (mime === undefined) {
    fail("UNEXPECTED_BUNDLE_ENTRY", `unsupported bundle extension: ${relative}`);
  }
  return mime;
}

export function blake3Bytes(bytes: Uint8Array): string {
  return `blake3:${bytesToHex(blake3(bytes))}`;
}

async function openRegular(filePath: string, maximum: number) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    fail("FILE_OPEN_FAILED", `${filePath}: ${(error as Error).message}`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      fail("NON_REGULAR_FILE", `${filePath} is not a regular file`);
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size > maximum) {
      fail("FILE_SIZE_EXCEEDED", `${filePath} exceeds ${maximum} bytes`);
    }
    return { handle, metadata };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function hashFile(filePath: string, maximum: number): Promise<{ size: number; blake3: string }> {
  const { handle, metadata } = await openRegular(filePath, maximum);
  const hasher = blake3.create({});
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let total = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum || total > metadata.size) {
        fail("FILE_CHANGED_DURING_READ", `${filePath} changed while hashing`);
      }
      hasher.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (total !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      fail("FILE_CHANGED_DURING_READ", `${filePath} changed while hashing`);
    }
    return { size: total, blake3: `blake3:${bytesToHex(hasher.digest())}` };
  } finally {
    await handle.close();
  }
}

function admitToolPath(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  if (
    normalized.length === 0 ||
    normalized !== normalized.normalize("NFC") ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes(":") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail("TOOL_SUBJECT_INVALID", `invalid npm package path: ${JSON.stringify(normalized)}`);
  }
  for (const component of normalized.split("/")) {
    if (component.length === 0 || component === "." || component === ".." || /[. ]$/u.test(component)) {
      fail("TOOL_SUBJECT_INVALID", `invalid npm package component: ${JSON.stringify(normalized)}`);
    }
  }
  return normalized;
}

async function toolTreeRecords(root: string, directory = root): Promise<Array<{ path: string; size: number; blake3: string }>> {
  const records: Array<{ path: string; size: number; blake3: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    const relative = admitToolPath(path.relative(root, absolute));
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      fail("TOOL_SUBJECT_INVALID", `npm package symlink rejected: ${relative}`);
    }
    if (entry.isDirectory() && metadata.isDirectory()) {
      records.push(...(await toolTreeRecords(root, absolute)));
    } else if (entry.isFile() && metadata.isFile()) {
      records.push({ path: relative, ...(await hashFile(absolute, MAX_FILE_BYTES)) });
    } else {
      fail("TOOL_SUBJECT_INVALID", `non-regular npm package entry: ${relative}`);
    }
    if (records.length > MAX_TOOL_TREE_FILES) fail("TOOL_SUBJECT_INVALID", "npm package has too many files");
  }
  return records;
}

export async function hashToolDirectory(root: string): Promise<{ size: number; file_count: number; blake3: string }> {
  const metadata = await lstat(root).catch(() => fail("TOOL_SUBJECT_INVALID", "npm package root is missing"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("TOOL_SUBJECT_INVALID", "npm package root must be a real directory");
  }
  const records = await toolTreeRecords(root);
  records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const portable = new Set<string>();
  let total = 0;
  for (const record of records) {
    const key = asciiLower(record.path);
    if (portable.has(key)) fail("TOOL_SUBJECT_INVALID", `npm package path collision: ${record.path}`);
    portable.add(key);
    total += record.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOOL_TREE_BYTES) {
      fail("TOOL_SUBJECT_INVALID", "npm package tree is oversized");
    }
  }
  if (records.length === 0) fail("TOOL_SUBJECT_INVALID", "npm package tree is empty");
  const body = new TextEncoder().encode(canonicalJson(records));
  const domain = new TextEncoder().encode("bullet.portal.tool-tree.v1\0");
  const framed = new Uint8Array(domain.length + body.length);
  framed.set(domain);
  framed.set(body, domain.length);
  return { size: total, file_count: records.length, blake3: blake3Bytes(framed) };
}

async function inspectDirectory(directory: string, relativeDirectory: "" | "assets"): Promise<FileRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records: FileRecord[] = [];
  for (const entry of entries) {
    const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (relativeDirectory === "" && entry.name === MANIFEST_NAME) continue;
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      fail("SYMLINK_REJECTED", `bundle symlink rejected: ${relative}`);
    }
    if (entry.isDirectory() && metadata.isDirectory()) {
      if (relative !== "assets") {
        fail("UNEXPECTED_BUNDLE_ENTRY", `unexpected bundle directory: ${relative}`);
      }
      records.push(...(await inspectDirectory(absolute, "assets")));
      continue;
    }
    if (!entry.isFile() || !metadata.isFile()) {
      fail("NON_REGULAR_FILE", `non-regular bundle entry rejected: ${relative}`);
    }
    const mime = admitBundlePath(relative);
    const digest = await hashFile(absolute, MAX_FILE_BYTES);
    records.push({ path: relative, size: digest.size, mime, blake3: digest.blake3 });
  }
  return records;
}

export function validateRecords(records: FileRecord[]): FileRecord[] {
  if (records.length === 0 || records.length > MAX_FILES) {
    fail("BUNDLE_ENTRY_COUNT", `bundle must contain 1..${MAX_FILES} files`);
  }
  const exact = new Set<string>();
  const portable = new Set<string>();
  let indexCount = 0;
  let total = 0;
  for (const record of records) {
    const mime = admitBundlePath(record.path);
    if (record.mime !== mime) fail("MIME_MISMATCH", `wrong MIME for ${record.path}`);
    if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_FILE_BYTES) {
      fail("FILE_SIZE_EXCEEDED", `invalid size for ${record.path}`);
    }
    validateDigest(record.blake3, `${record.path}.blake3`);
    const portableKey = asciiLower(record.path.normalize("NFC"));
    if (exact.has(record.path)) fail("DUPLICATE_BUNDLE_PATH", `duplicate path: ${record.path}`);
    if (portable.has(portableKey)) fail("PORTABLE_PATH_COLLISION", `portable path collision: ${record.path}`);
    exact.add(record.path);
    portable.add(portableKey);
    if (record.path === "index.html") indexCount += 1;
    total += record.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) {
      fail("BUNDLE_SIZE_EXCEEDED", `bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
  }
  if (indexCount !== 1) fail("MISSING_ENTRYPOINT", "bundle must contain exactly one index.html");
  return [...records].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail("NON_CANONICAL_VALUE", "manifest numbers must be unsigned integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") fail("NON_CANONICAL_VALUE", "unsupported manifest value");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function validateSubjects(source: SourceSubject, tools: ToolSubject[]): ToolSubject[] {
  if (source.repository !== "bullet-portal") fail("INVALID_SUBJECT", "wrong source repository");
  validateOid(source.commit_oid, "source.commit_oid");
  validateOid(source.tree_oid, "source.tree_oid");
  const ordered = [...tools].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (ordered.map((tool) => tool.name).join(",") !== "git,node,npm") {
    fail("INVALID_SUBJECT", "tool subjects must contain exactly git, node, and npm");
  }
  for (const tool of ordered) {
    if (!/^[\x20-\x7e]{1,160}$/.test(tool.version)) fail("INVALID_SUBJECT", `${tool.name} version is invalid`);
    if (!Number.isSafeInteger(tool.size) || tool.size <= 0) fail("INVALID_SUBJECT", `${tool.name} size is invalid`);
    validateDigest(tool.blake3, `${tool.name}.blake3`);
    if (tool.name === "npm") {
      if (!Number.isSafeInteger(tool.file_count) || (tool.file_count ?? 0) <= 0) {
        fail("INVALID_SUBJECT", "npm file_count is invalid");
      }
    } else if (tool.file_count !== undefined) {
      fail("INVALID_SUBJECT", `${tool.name} must not carry a directory file_count`);
    }
  }
  return ordered;
}

export async function createManifest(input: ManifestInput): Promise<BundleManifest> {
  const distMetadata = await lstat(input.distPath).catch(() => fail("BUNDLE_MISSING", "dist directory is missing"));
  if (!distMetadata.isDirectory() || distMetadata.isSymbolicLink()) {
    fail("BUNDLE_ROOT_INVALID", "dist must be a real directory");
  }
  const files = validateRecords(await inspectDirectory(input.distPath, ""));
  const packageLock = await hashFile(input.packageLockPath, MAX_LOCK_BYTES);
  const body = {
    schema_version: "bullet.portal.bundle.v1" as const,
    source: input.source,
    package_lock: { path: "package-lock.json" as const, ...packageLock },
    tools: validateSubjects(input.source, input.tools),
    files,
    total_size: files.reduce((sum, record) => sum + record.size, 0),
  };
  const canonicalBody = new TextEncoder().encode(canonicalJson(body));
  const domain = new TextEncoder().encode(`${ROOT_DOMAIN}\0`);
  const framed = new Uint8Array(domain.length + canonicalBody.length);
  framed.set(domain);
  framed.set(canonicalBody, domain.length);
  return { ...body, root: blake3Bytes(framed) };
}

export function manifestBytes(manifest: BundleManifest): Buffer {
  return Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
}

export async function expectedManifestBytes(input: ManifestInput): Promise<Buffer> {
  return manifestBytes(await createManifest(input));
}

export async function readBounded(filePath: string, maximum = MAX_MANIFEST_BYTES): Promise<Buffer> {
  const { handle, metadata } = await openRegular(filePath, maximum);
  try {
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) fail("TRUNCATED_FILE", `${filePath} was truncated while reading`);
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      fail("FILE_CHANGED_DURING_READ", `${filePath} grew while reading`);
    }
    const after = await handle.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      fail("FILE_CHANGED_DURING_READ", `${filePath} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function assertExactManifest(actual: Uint8Array, expected: Uint8Array): void {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) {
    fail("BUNDLE_MANIFEST_DRIFT", "bundle manifest does not match the exact source, tools, lock, and emitted files");
  }
}
