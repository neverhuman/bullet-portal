import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expected = ["fast", "lint", "contract", "security", "docs"];

export function validateNeeds(needs) {
  const keys = Object.keys(needs).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    throw new Error(`MISSING_REQUIRED_JOB: expected ${wanted.join(",")}; got ${keys.join(",")}`);
  }
  for (const lane of expected) {
    const job = needs[lane];
    if (job?.result !== "success") {
      throw new Error(`REQUIRED_JOB_NOT_SUCCESSFUL: ${lane}=${job?.result ?? "missing"}`);
    }
    if (job?.outputs?.observation !== "true") {
      throw new Error(`MISSING_CI_OBSERVATION: ${lane}`);
    }
  }
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--jeryu") {
    console.log("[ci] Jeryu dependency convergence reached");
  } else {
    const raw = process.env.NEEDS_JSON;
    if (!raw) throw new Error("MISSING_NEEDS_JSON");
    const lanes = validateNeeds(JSON.parse(raw));
    console.log(`[ci] required convergence passed: ${lanes.join(", ")}`);
  }
}
