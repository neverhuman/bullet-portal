import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  junitIdentityDigest,
  vitestIdentityDigest,
} from "./report-identity.mjs";

const root = mkdtempSync(join(tmpdir(), "bullet-portal-report-"));
try {
  const report = fixture("second identity");
  const path = join(root, "vitest.json");
  writeFileSync(path, JSON.stringify(report));
  const digest = vitestIdentityDigest(report);
  assert.equal(run("vitest", path, digest).status, 0, "exact identity stream was refused");

  const canonicalVitest = JSON.stringify(report);
  for (const [label, hostile] of [
    [
      "duplicate success",
      canonicalVitest.replace('{"success":true', '{"success":false,"success":true'),
    ],
    [
      "duplicate total",
      canonicalVitest.replace(
        '"numTotalTests":2',
        '"numTotalTests":0,"numTotalTests":2',
      ),
    ],
    [
      "duplicate assertion status",
      canonicalVitest.replace('"status":"passed"', '"status":"failed","status":"passed"'),
    ],
    [
      "duplicate assertion identity",
      canonicalVitest.replace(
        '"fullName":"fixture first identity"',
        '"fullName":"substituted identity","fullName":"fixture first identity"',
      ),
    ],
    [
      "escaped duplicate assertion identity",
      canonicalVitest.replace(
        '"fullName":"fixture first identity"',
        '"full\\u004eame":"substituted identity","fullName":"fixture first identity"',
      ),
    ],
  ]) {
    writeFileSync(path, hostile);
    const duplicateKey = run("vitest", path, digest);
    assert.notEqual(duplicateKey.status, 0, `${label} was admitted`);
    assert.match(duplicateKey.stderr, /TEST_REPORT_JSON_DUPLICATE_KEY/u, label);
  }

  writeFileSync(path, JSON.stringify(fixture("substituted identity")));
  const substitution = run("vitest", path, digest);
  assert.notEqual(substitution.status, 0, "same-count identity substitution was admitted");
  assert.match(substitution.stderr, /TEST_IDENTITY_DIGEST_DRIFT/u);

  const duplicate = fixture("first identity");
  writeFileSync(path, JSON.stringify(duplicate));
  assert.match(run("vitest", path, digest).stderr, /TEST_IDENTITY_DUPLICATE/u);

  const missingStatus = fixture("second identity");
  delete missingStatus.testResults[0].assertionResults[1].status;
  writeFileSync(path, JSON.stringify(missingStatus));
  assert.match(run("vitest", path, digest).stderr, /INCOMPLETE_TEST_PARTITION/u);

  const traversing = fixture("second identity");
  traversing.testResults[0].name = "src/a/../../../outside.test.ts";
  writeFileSync(path, JSON.stringify(traversing));
  assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_PATH_INVALID/u);

  const backslash = fixture("second identity");
  backslash.testResults[0].name = "src\\fixture.test.ts";
  writeFileSync(path, JSON.stringify(backslash));
  assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_PATH_INVALID/u);

  for (const invalidPath of [
    "src/./fixture.test.ts",
    "src/control\u0000.test.ts",
    "src/cafe\u0301.test.ts",
  ]) {
    const invalid = fixture("second identity");
    invalid.testResults[0].name = invalidPath;
    writeFileSync(path, JSON.stringify(invalid));
    assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_PATH_INVALID/u);
  }

  for (const codeUnit of [0xd800, 0xd801]) {
    const surrogate = String.fromCharCode(codeUnit);
    const invalidName = fixture("second identity");
    invalidName.testResults[0].assertionResults[1].fullName = `fixture ${surrogate}`;
    writeFileSync(path, JSON.stringify(invalidName));
    assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

    const invalidPath = fixture("second identity");
    invalidPath.testResults[0].name = `src/${surrogate}.test.ts`;
    writeFileSync(path, JSON.stringify(invalidPath));
    assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_PATH_INVALID/u);
  }

  const junitPath = join(root, "playwright.xml");
  const junit = junitFixture("second identity");
  writeFileSync(junitPath, junit);
  const junitDigest = junitIdentityDigest(junit);
  assert.equal(run("junit", junitPath, junitDigest).status, 0, "exact JUnit was refused");

  for (const [label, entity] of [
    ["raw ampersand", "&"],
    ["incomplete entity", "&amp"],
    ["unknown entity", "&copy;"],
  ]) {
    writeFileSync(junitPath, junit.replace("<testsuites ", `<testsuites audit="${entity}" `));
    const malformedEntity = run("junit", junitPath, junitDigest);
    assert.notEqual(malformedEntity.status, 0, `${label} was admitted`);
    assert.match(malformedEntity.stderr, /TEST_REPORT_SHAPE_INVALID/u, label);
  }

  for (const attribute of [
    'status="failed"',
    'result="failure"',
    'failure="1"',
    'error="true"',
    'skipped="true"',
  ]) {
    writeFileSync(junitPath, junit.replace("<testcase ", `<testcase ${attribute} `));
    const outcomeAttribute = run("junit", junitPath, junitDigest);
    assert.notEqual(outcomeAttribute.status, 0, `${attribute} was admitted`);
    assert.match(outcomeAttribute.stderr, /TEST_REPORT_SHAPE_INVALID/u, attribute);
  }

  writeFileSync(junitPath, junit.replace("<testcase ", '<testcase audit="closed" '));
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  writeFileSync(junitPath, junitFixture("substituted identity"));
  const junitSubstitution = run("junit", junitPath, junitDigest);
  assert.notEqual(junitSubstitution.status, 0, "same-count JUnit substitution was admitted");
  assert.match(junitSubstitution.stderr, /TEST_IDENTITY_DIGEST_DRIFT/u);

  writeFileSync(junitPath, junitFixture("first identity"));
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_IDENTITY_DUPLICATE/u);

  const commentOnly = `<testsuites tests="2" failures="0" errors="0" skipped="0">
<testsuite tests="2" failures="0" errors="0" skipped="0">
<!-- <testcase classname="e2e/fixture.spec.ts" name="first identity"/>
<testcase classname="e2e/fixture.spec.ts" name="second identity"/> -->
</testsuite></testsuites>`;
  writeFileSync(junitPath, commentOnly);
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  for (const outcome of ["failure", "error", "skipped"]) {
    writeFileSync(junitPath, junitFixture("second identity", `<${outcome}/>`));
    assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);
  }

  for (const forbidden of [
    "<!--comment-->",
    "<![CDATA[data]]>",
    "<?target data?>",
    "<!DOCTYPE testsuites>",
    "<!ENTITY fake \"value\">",
  ]) {
    writeFileSync(junitPath, `${forbidden}${junit}`);
    assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);
  }

  writeFileSync(
    junitPath,
    junit.replace('tests="2" failures', 'tests="2" tests="2" failures'),
  );
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  writeFileSync(junitPath, junit.replace('tests="2" failures', 'tests="3" failures'));
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  writeFileSync(
    junitPath,
    junit.replace('<testsuite tests="2"', '<testsuite tests="3"'),
  );
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  writeFileSync(junitPath, junit.replace("</testsuite>", "</testsuites>"));
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  writeFileSync(junitPath, `${junit}<testsuites tests="0" failures="0" errors="0" skipped="0"/>`);
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_SHAPE_INVALID/u);

  writeFileSync(
    junitPath,
    junit.replace(
      'classname="e2e/fixture.spec.ts"',
      'classname="e2e/a/../../../outside.spec.ts"',
    ),
  );
  assert.match(run("junit", junitPath, junitDigest).stderr, /TEST_REPORT_PATH_INVALID/u);

  writeFileSync(path, " ".repeat(1024 * 1024 + 1));
  assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_SIZE_INVALID/u);

  writeFileSync(path, Buffer.from([0xff]));
  assert.match(run("vitest", path, digest).stderr, /TEST_REPORT_ENCODING_INVALID/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("[ci] Vitest/JUnit identity digests and count-neutral hostiles passed");

function fixture(secondName) {
  return {
    success: true,
    numTotalTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: join(process.cwd(), "src", "fixture.test.ts"),
        assertionResults: [
          { fullName: "fixture first identity", status: "passed" },
          { fullName: `fixture ${secondName}`, status: "passed" },
        ],
      },
    ],
  };
}

function junitFixture(secondName, firstBody = "") {
  return `<testsuites tests="2" failures="0" errors="0" skipped="0">
<testsuite tests="2" failures="0" errors="0" skipped="0">
<testcase classname="e2e/fixture.spec.ts" name="first identity">${firstBody}</testcase>
<testcase classname="e2e/fixture.spec.ts" name="${secondName}"/>
</testsuite></testsuites>\n`;
}

function run(kind, path, digest) {
  return spawnSync(
    process.execPath,
    ["ops/ci/assert-report.mjs", kind, path, "2", digest],
    { encoding: "utf8" },
  );
}
