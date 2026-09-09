import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const patterns = [
  ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["GITHUB_TOKEN", /gh[pousr]_[A-Za-z0-9]{36,255}/],
  ["AWS_ACCESS_KEY", /AKIA[0-9A-Z]{16}/],
  ["SLACK_TOKEN", /xox[baprs]-[A-Za-z0-9-]{20,}/],
];
const findings = [];
for (const path of tracked) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [code, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${path}:${code}`);
  }
}
if (findings.length > 0) {
  console.error(`[ci] PREINSTALL_SOURCE_SCAN_FAILED: ${findings.join(", ")}`);
  process.exit(1);
}
console.log(`[ci] preinstall source/lock scan passed (${tracked.length} source files)`);
