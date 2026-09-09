import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

const JUNIT_ATTRIBUTES = {
  testsuites: new Set(["id", "name", "tests", "failures", "skipped", "errors", "time"]),
  testsuite: new Set([
    "name",
    "timestamp",
    "hostname",
    "tests",
    "failures",
    "skipped",
    "time",
    "errors",
  ]),
  testcase: new Set(["name", "classname", "time"]),
};

export function vitestIdentities(report, root = process.cwd()) {
  if (!Array.isArray(report.testResults)) {
    throw new Error("TEST_REPORT_SHAPE_INVALID: Vitest testResults is absent");
  }
  const identities = [];
  for (const suite of report.testResults) {
    if (typeof suite?.name !== "string" || !Array.isArray(suite.assertionResults)) {
      throw new Error("TEST_REPORT_SHAPE_INVALID: Vitest suite is malformed");
    }
    const file = normalizedFile(root, suite.name);
    for (const assertion of suite.assertionResults) {
      const name = assertion?.fullName;
      if (assertion?.status !== "passed") {
        throw new Error("INCOMPLETE_TEST_PARTITION: Vitest assertion is not passed");
      }
      if (!validIdentityText(name)) {
        throw new Error("TEST_REPORT_SHAPE_INVALID: Vitest test name is malformed");
      }
      identities.push(`${file}\t${name}`);
    }
  }
  identities.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (new Set(identities).size !== identities.length) {
    throw new Error("TEST_IDENTITY_DUPLICATE: Vitest identities are not unique");
  }
  return identities;
}

export function vitestIdentityDigest(report, root = process.cwd()) {
  const identities = vitestIdentities(report, root);
  return identityDigest(identities);
}

export function junitIdentities(xml, root = process.cwd()) {
  return junitReport(xml, root).identities;
}

export function junitReport(xml, root = process.cwd()) {
  const parsed = parseJunit(xml);
  const identities = parsed.testcases.map(({ classname, name }) => {
    const file = normalizedFile(root, classname);
    if (!validIdentityText(name)) {
      throw new Error("TEST_REPORT_SHAPE_INVALID: JUnit test name is malformed");
    }
    return `${file}\t${name}`;
  });
  identities.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (new Set(identities).size !== identities.length) {
    throw new Error("TEST_IDENTITY_DUPLICATE: JUnit identities are not unique");
  }
  return { ...parsed, identities };
}

export function junitIdentityDigest(xml, root = process.cwd()) {
  return identityDigest(junitIdentities(xml, root));
}

export function identityDigest(identities) {
  const bytes = identities.length === 0 ? "" : `${identities.join("\n")}\n`;
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeXml(value, field) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/u.test(value)) {
    throw new Error(`TEST_REPORT_SHAPE_INVALID: JUnit ${field} has an unknown entity`);
  }
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity) => {
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity];
  });
}

function normalizedFile(root, name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== name.normalize("NFC") ||
    /[\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(name)
  ) {
    throw new Error("TEST_REPORT_PATH_INVALID: test file is not canonical");
  }
  const absolute = isAbsolute(name);
  const segments = (absolute ? name.slice(1) : name).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("TEST_REPORT_PATH_INVALID: test file has a non-canonical segment");
  }
  const repository = resolve(root);
  const candidate = absolute ? resolve(name) : resolve(repository, name);
  const relativePath = relative(repository, candidate);
  const file = relativePath.split(sep).join("/");
  if (
    file.length === 0 ||
    file === ".." ||
    file.startsWith("../") ||
    isAbsolute(relativePath) ||
    file !== file.normalize("NFC") ||
    file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("TEST_REPORT_PATH_INVALID: test file is outside the repository");
  }
  return file;
}

function validIdentityText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
  );
}

function parseJunit(xml) {
  if (
    typeof xml !== "string" ||
    /<!--|<!\[CDATA\[|<\?|<!DOCTYPE|<!ENTITY/iu.test(xml)
  ) {
    throw new Error("TEST_REPORT_SHAPE_INVALID: JUnit document has forbidden markup");
  }
  const scanner = new XmlScanner(xml);
  const root = scanner.open("testsuites");
  validateAttributes(root.attributes, "testsuites");
  if (root.selfClosing) {
    throw new Error("TEST_REPORT_SHAPE_INVALID: JUnit testsuites root is empty");
  }
  const totals = aggregateCounts(root.attributes, "testsuites");
  const observed = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const testcases = [];
  let suiteCount = 0;
  while (!scanner.atClose("testsuites")) {
    const suite = scanner.open("testsuite");
    validateAttributes(suite.attributes, "testsuite");
    const counts = aggregateCounts(suite.attributes, "testsuite");
    const suiteCases = [];
    if (!suite.selfClosing) {
      while (!scanner.atClose("testsuite")) {
        const testcase = scanner.open("testcase");
        validateAttributes(testcase.attributes, "testcase");
        const name = requiredAttribute(testcase.attributes, "name", "testcase");
        const classname = requiredAttribute(testcase.attributes, "classname", "testcase");
        if (!testcase.selfClosing) {
          scanner.close("testcase");
        }
        suiteCases.push({ classname, name });
      }
      scanner.close("testsuite");
    }
    if (suiteCases.length !== counts.tests) {
      throw new Error("TEST_REPORT_SHAPE_INVALID: JUnit testsuite count disagrees with testcases");
    }
    for (const field of ["tests", "failures", "errors", "skipped"]) {
      observed[field] += counts[field];
      if (!Number.isSafeInteger(observed[field])) {
        throw new Error("TEST_REPORT_SHAPE_INVALID: JUnit aggregate is unsafe");
      }
    }
    testcases.push(...suiteCases);
    suiteCount += 1;
  }
  scanner.close("testsuites");
  scanner.finish();
  if (suiteCount === 0) {
    throw new Error("TEST_REPORT_SHAPE_INVALID: JUnit contains no testsuite");
  }
  for (const field of ["tests", "failures", "errors", "skipped"]) {
    if (totals[field] !== observed[field]) {
      throw new Error(`TEST_REPORT_SHAPE_INVALID: JUnit ${field} aggregate disagrees`);
    }
  }
  return { ...totals, testcases };
}

function validateAttributes(attributes, element) {
  const allowed = JUNIT_ATTRIBUTES[element];
  for (const attribute of attributes.keys()) {
    if (!allowed.has(attribute)) {
      throw new Error(
        `TEST_REPORT_SHAPE_INVALID: JUnit ${element} ${attribute} attribute is unknown`,
      );
    }
  }
}

function aggregateCounts(attributes, element) {
  const counts = {};
  for (const field of ["tests", "failures", "errors", "skipped"]) {
    const value = requiredAttribute(attributes, field, element);
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
      throw new Error(`TEST_REPORT_SHAPE_INVALID: JUnit ${element} ${field} is invalid`);
    }
    counts[field] = Number(value);
    if (!Number.isSafeInteger(counts[field])) {
      throw new Error(`TEST_REPORT_SHAPE_INVALID: JUnit ${element} ${field} is unsafe`);
    }
  }
  return counts;
}

function requiredAttribute(attributes, name, element) {
  const value = attributes.get(name);
  if (value === undefined) {
    throw new Error(`TEST_REPORT_SHAPE_INVALID: JUnit ${element} ${name} is absent`);
  }
  return value;
}

class XmlScanner {
  constructor(source) {
    this.source = source;
    this.offset = 0;
  }

  open(expected) {
    this.whitespace();
    this.expect("<");
    if (this.source.startsWith("/", this.offset)) this.invalid("unexpected close element");
    const name = this.name();
    if (name !== expected) this.invalid(`expected ${expected}, found ${name}`);
    const attributes = new Map();
    for (;;) {
      const separated = this.whitespace();
      if (this.source.startsWith("/>", this.offset)) {
        this.offset += 2;
        return { attributes, selfClosing: true };
      }
      if (this.source.startsWith(">", this.offset)) {
        this.offset += 1;
        return { attributes, selfClosing: false };
      }
      if (!separated) this.invalid("attributes are not separated");
      const attribute = this.name();
      if (attributes.has(attribute)) this.invalid(`duplicate ${attribute} attribute`);
      this.whitespace();
      this.expect("=");
      this.whitespace();
      const quote = this.source[this.offset];
      if (quote !== '"' && quote !== "'") this.invalid("attribute value is unquoted");
      this.offset += 1;
      const end = this.source.indexOf(quote, this.offset);
      if (end < 0) this.invalid("attribute value is unterminated");
      const raw = this.source.slice(this.offset, end);
      if (/[<\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
        this.invalid("attribute value is malformed");
      }
      attributes.set(attribute, decodeXml(raw, attribute));
      this.offset = end + 1;
    }
  }

  atClose(expected) {
    this.whitespace();
    return this.source.startsWith(`</${expected}`, this.offset);
  }

  close(expected) {
    this.whitespace();
    this.expect("</");
    const name = this.name();
    if (name !== expected) this.invalid(`expected closing ${expected}, found ${name}`);
    this.whitespace();
    this.expect(">");
  }

  finish() {
    this.whitespace();
    if (this.offset !== this.source.length) this.invalid("trailing material");
  }

  name() {
    const start = this.offset;
    if (!/[A-Za-z_:]/u.test(this.source[this.offset] ?? "")) this.invalid("element name is absent");
    this.offset += 1;
    while (/[A-Za-z0-9_.:-]/u.test(this.source[this.offset] ?? "")) this.offset += 1;
    return this.source.slice(start, this.offset);
  }

  whitespace() {
    const start = this.offset;
    while (/[ \t\r\n]/u.test(this.source[this.offset] ?? "")) this.offset += 1;
    return this.offset !== start;
  }

  expect(value) {
    if (!this.source.startsWith(value, this.offset)) this.invalid(`expected ${value}`);
    this.offset += value.length;
  }

  invalid(detail) {
    throw new Error(`TEST_REPORT_SHAPE_INVALID: JUnit ${detail} at byte ${this.offset}`);
  }
}
