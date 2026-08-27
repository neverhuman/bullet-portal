import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";
import {
  identityDigest,
  junitReport,
  vitestIdentities,
  vitestIdentityDigest,
} from "./report-identity.mjs";

const MAX_REPORT_BYTES = 1024 * 1024;

const [kind, path, expectedText, expectedDigest] = process.argv.slice(2);
if (!kind || !path) {
  throw new Error(
    "usage: assert-report.mjs <vitest|junit> <path> [expected] [identity-sha256]",
  );
}
const expected = expectedText === undefined ? undefined : Number(expectedText);
if (expected !== undefined && (!Number.isInteger(expected) || expected <= 0)) {
  throw new Error("invalid expected test count");
}
if (expectedDigest !== undefined && !/^[0-9a-f]{64}$/u.test(expectedDigest)) {
  throw new Error("invalid expected identity digest");
}

if (kind === "vitest") {
  const report = parseUniqueJson(readReport(path));
  if (!Number.isInteger(report.numTotalTests) || report.numTotalTests <= 0) {
    throw new Error("ZERO_TEST_PARTITION: vitest executed no tests");
  }
  if (expected !== undefined && report.numTotalTests !== expected) {
    throw new Error(`TEST_INVENTORY_DRIFT: vitest=${report.numTotalTests}, expected=${expected}`);
  }
  const identities = vitestIdentities(report);
  if (identities.length !== report.numTotalTests) {
    throw new Error(
      `TEST_REPORT_SHAPE_INVALID: identities=${identities.length}, total=${report.numTotalTests}`,
    );
  }
  const digest = vitestIdentityDigest(report);
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new Error(
      `TEST_IDENTITY_DIGEST_DRIFT: vitest=${digest}, expected=${expectedDigest}`,
    );
  }
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    throw new Error("INCOMPLETE_TEST_PARTITION: vitest report is not all-pass");
  }
  console.log(`[ci] vitest report: ${report.numTotalTests} passed, zero skipped`);
} else if (kind === "junit") {
  const xml = readReport(path);
  const report = junitReport(xml);
  const tests = report.tests;
  if (!Number.isInteger(tests) || tests <= 0) {
    throw new Error("ZERO_TEST_PARTITION: Playwright executed no tests");
  }
  if (expected !== undefined && tests !== expected) {
    throw new Error(`TEST_INVENTORY_DRIFT: junit=${tests}, expected=${expected}`);
  }
  const identities = report.identities;
  if (identities.length !== tests) {
    throw new Error(`TEST_REPORT_SHAPE_INVALID: identities=${identities.length}, total=${tests}`);
  }
  const digest = identityDigest(identities);
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new Error(
      `TEST_IDENTITY_DIGEST_DRIFT: junit=${digest}, expected=${expectedDigest}`,
    );
  }
  for (const field of ["failures", "errors", "skipped"]) {
    if (report[field] !== 0) throw new Error(`INCOMPLETE_TEST_PARTITION: ${field} is nonzero`);
  }
  console.log(`[ci] Playwright report: ${tests} passed, zero skipped`);
} else {
  throw new Error(`unknown report kind: ${kind}`);
}

function readReport(reportPath) {
  const descriptor = openSync(reportPath, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_REPORT_BYTES) {
      throw new Error("TEST_REPORT_SIZE_INVALID: report must be a nonempty regular file at most 1 MiB");
    }
    const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > MAX_REPORT_BYTES) {
      throw new Error("TEST_REPORT_SIZE_INVALID: report changed size or exceeds 1 MiB");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error("TEST_REPORT_ENCODING_INVALID: report is not UTF-8");
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseUniqueJson(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("TEST_REPORT_JSON_INVALID: Vitest report is malformed JSON");
  }
  scanJsonMembers(source);
  return value;
}

function scanJsonMembers(source) {
  let offset = 0;
  value();
  whitespace();
  if (offset !== source.length) invalid();

  function value() {
    whitespace();
    const token = source[offset];
    if (token === "{") {
      object();
    } else if (token === "[") {
      array();
    } else if (token === '"') {
      string();
    } else {
      primitive();
    }
  }

  function object() {
    expect("{");
    whitespace();
    if (consume("}")) return;
    const keys = new Set();
    for (;;) {
      const key = string();
      if (keys.has(key)) {
        throw new Error(
          "TEST_REPORT_JSON_DUPLICATE_KEY: Vitest report contains a duplicate decoded member",
        );
      }
      keys.add(key);
      whitespace();
      expect(":");
      value();
      whitespace();
      if (consume("}")) return;
      expect(",");
      whitespace();
    }
  }

  function array() {
    expect("[");
    whitespace();
    if (consume("]")) return;
    for (;;) {
      value();
      whitespace();
      if (consume("]")) return;
      expect(",");
    }
  }

  function string() {
    const start = offset;
    expect('"');
    while (offset < source.length) {
      if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset));
      }
      if (source[offset] === "\\") {
        offset += source[offset + 1] === "u" ? 6 : 2;
      } else {
        offset += 1;
      }
    }
    invalid();
  }

  function primitive() {
    const start = offset;
    while (offset < source.length && !/[,\]}\s]/u.test(source[offset])) offset += 1;
    if (offset === start) invalid();
  }

  function whitespace() {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  }

  function consume(expected) {
    if (!source.startsWith(expected, offset)) return false;
    offset += expected.length;
    return true;
  }

  function expect(expected) {
    if (!consume(expected)) invalid();
  }

  function invalid() {
    throw new Error("TEST_REPORT_JSON_INVALID: Vitest report is malformed JSON");
  }
}
