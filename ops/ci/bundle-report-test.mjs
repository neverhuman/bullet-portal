import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBundleReport } from "./bundle-report.mjs";

// Synthetic parser input, never an execution result or published observation.
const names = [...readFileSync("ops/build/bundle-tests.ts", "utf8")
  .matchAll(/^test\("([^"]+)"/gm)].map((match) => match[1]);
assert.equal(names.length, 5);
const fixture = ["TAP version 13", ...names.map((name, i) => `ok ${i + 1} - ${name}`),
  "1..5", "# tests 5", "# suites 0", "# pass 5", "# fail 0", "# cancelled 0",
  "# skipped 0", "# todo 0", "# duration_ms 1.2", ""].join("\n");
assert.equal(validateBundleReport(fixture), 5);
const variants = ["", fixture.slice(0, fixture.indexOf("1..5")), fixture + fixture,
  fixture.replace("ok 1 -", "not ok 1 -"), fixture.replace(names[0], "replacement identity"),
  fixture.replace("ok 2 -", "ok 1 -"), fixture.replace("1..5", "1..0"),
  fixture.replace("# pass 5", "# pass 0"), fixture.replace("# fail 0", "# fail 1"),
  fixture.replace("# cancelled 0", "# cancelled 1"), fixture.replace("# skipped 0", "# skipped 1"),
  fixture.replace("# todo 0", "# todo 1"), fixture.replace("# suites 0", "# suites 1"),
  fixture + "ok 6 - extra\n", fixture + "# pass 5\n", fixture + "Bail out!\n",
  fixture.replace(names[0], names[0] + " # SKIP"), fixture.replace(names[0], names[0] + " # TODO"),
  fixture.replace("# tests 5", ""), fixture + "x".repeat(1024 * 1024)];
for (const variant of variants) assert.throws(() => validateBundleReport(variant), /BUNDLE_REPORT_INVALID/);
console.log(`[ci] bundle report positive and ${variants.length} hostile fixtures passed`);
