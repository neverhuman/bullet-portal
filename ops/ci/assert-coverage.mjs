import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const globalFloors = { lines: 88, statements: 88, functions: 90, branches: 85 };
const perFileFloors = {
  "src/api.ts": { lines: 82, statements: 82, functions: 85, branches: 80 },
  "src/apiValidation.ts": { lines: 85, statements: 85, functions: 90, branches: 88 },
  "src/observation.ts": { lines: 82, statements: 82, functions: 95, branches: 85 },
  "src/sse.ts": { lines: 88, statements: 88, functions: 95, branches: 78 },
  "src/hooks/useEventStream.ts": { lines: 75, statements: 75, functions: 80, branches: 80 },
  "src/hooks/useProjection.ts": { lines: 85, statements: 85, functions: 95, branches: 75 },
  "src/pages/ProjectedSurface.tsx": { lines: 65, statements: 65, functions: 70, branches: 55 },
};

checkFloors("total", report.total, globalFloors);
for (const [relative, floors] of Object.entries(perFileFloors)) {
  checkFloors(relative, report[resolve(relative)], floors);
}
console.log(
  `[ci] coverage ratchets passed: global=${JSON.stringify(globalFloors)}, critical_files=${Object.keys(perFileFloors).length}`,
);

function checkFloors(subject, coverage, floors) {
  for (const [metric, floor] of Object.entries(floors)) {
    const value = coverage?.[metric]?.pct;
    if (typeof value !== "number" || value < floor) {
      throw new Error(
        `COVERAGE_RATCHET_FAILED: ${subject}:${metric}=${value ?? "missing"} < ${floor}`,
      );
    }
  }
}
