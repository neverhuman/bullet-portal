import { readFileSync } from "node:fs";

const [kind, path, expectedText] = process.argv.slice(2);
if (!kind || !path) throw new Error("usage: assert-report.mjs <vitest|junit> <path> [expected]");
const expected = expectedText === undefined ? undefined : Number(expectedText);
if (expected !== undefined && (!Number.isInteger(expected) || expected <= 0)) {
  throw new Error("invalid expected test count");
}

if (kind === "vitest") {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isInteger(report.numTotalTests) || report.numTotalTests <= 0) {
    throw new Error("ZERO_TEST_PARTITION: vitest executed no tests");
  }
  if (expected !== undefined && report.numTotalTests !== expected) {
    throw new Error(`TEST_INVENTORY_DRIFT: vitest=${report.numTotalTests}, expected=${expected}`);
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
  const xml = readFileSync(path, "utf8");
  const root = xml.match(/<testsuites\b([^>]*)>/)?.[1];
  if (!root) throw new Error("MISSING_TEST_REPORT: JUnit testsuites root absent");
  const value = (name) => Number(root.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? NaN);
  const tests = value("tests");
  if (!Number.isInteger(tests) || tests <= 0) {
    throw new Error("ZERO_TEST_PARTITION: Playwright executed no tests");
  }
  if (expected !== undefined && tests !== expected) {
    throw new Error(`TEST_INVENTORY_DRIFT: junit=${tests}, expected=${expected}`);
  }
  for (const field of ["failures", "errors", "skipped"]) {
    if (value(field) !== 0) throw new Error(`INCOMPLETE_TEST_PARTITION: ${field} is nonzero`);
  }
  console.log(`[ci] Playwright report: ${tests} passed, zero skipped`);
} else {
  throw new Error(`unknown report kind: ${kind}`);
}
