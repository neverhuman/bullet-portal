import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = ".ci-artifacts";
if (!existsSync(root)) throw new Error("MISSING_CI_ARTIFACTS");
const patterns = [
  ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["GITHUB_TOKEN", /gh[pousr]_[A-Za-z0-9]{36,255}/],
  ["BULLET_BOOTSTRAP", /boot_[0-9a-f]{64}/],
  ["BULLET_WORKER", /wrk_[0-9a-f]{64}/],
];
const findings = [];
walk(root);
if (findings.length > 0) {
  throw new Error(`ARTIFACT_REDACTION_FAILED: ${findings.join(", ")}`);
}
console.log("[ci] artifact redaction scan passed");

function scan(path, bytes) {
  const text = bytes.toString("utf8");
  for (const [code, pattern] of patterns) if (pattern.test(text)) findings.push(`${path}:${code}`);
}
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".zip")) {
      scan(full, execFileSync("unzip", ["-p", full], { maxBuffer: 64 * 1024 * 1024 }));
    } else if (entry.isFile()) scan(full, readFileSync(full));
  }
}
