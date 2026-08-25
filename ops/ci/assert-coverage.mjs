import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const floors = { lines: 88, statements: 88, functions: 90, branches: 85 };
for (const [metric, floor] of Object.entries(floors)) {
  const value = report.total?.[metric]?.pct;
  if (typeof value !== "number" || value < floor) {
    throw new Error(`COVERAGE_RATCHET_FAILED: ${metric}=${value ?? "missing"} < ${floor}`);
  }
}
console.log(`[ci] coverage ratchet passed: ${JSON.stringify(floors)}`);
