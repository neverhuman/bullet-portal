import { readFileSync } from "node:fs";

const response = (platform) => ({
  schema_version: "bullet.platform-refusal.v1",
  code: "PORTAL_PROJECTION_ONLY",
  status: "REFUSED",
  requested_effect: "mutation-capable-family-proof",
  mutation_capable: false,
  platform,
});
const validate = (value) => {
  if (
    value?.code !== "PORTAL_PROJECTION_ONLY" ||
    value?.status !== "REFUSED" ||
    value?.mutation_capable !== false
  ) {
    throw new Error("INVALID_PLATFORM_REFUSAL");
  }
};

if (process.argv[2] === "--self-test") {
  validate(response("test"));
  console.log("[ci] platform refusal self-test passed");
} else if (process.argv[2] === "--check") {
  validate(JSON.parse(readFileSync(process.argv[3], "utf8")));
  console.log("[ci] portable mutation refusal verified");
} else {
  if (!new Set(["darwin", "win32"]).has(process.platform)) {
    throw new Error(`PORTABLE_PROOF_WRONG_HOST: ${process.platform}`);
  }
  console.log(JSON.stringify(response(process.platform)));
}
