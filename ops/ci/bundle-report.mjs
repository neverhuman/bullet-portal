import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const names = [
  "BLAKE3 vectors and manifest bytes are deterministic and canonically ordered",
  "content, membership, name, lock, and tool mutations invalidate the exact manifest",
  "hostile paths, duplicates, portable collisions, symlinks, and unexpected files fail closed",
  "Git source admission rejects tracked, untracked, and linked-worktree ambiguity",
  "generate/check is idempotent and detects post-generation drift",
];
const fail = () => { throw new Error("BUNDLE_REPORT_INVALID: expected all five exact passing bundle tests"); };

// This is the pinned Node 22 TAP dialect for this suite, not a general TAP parser.
export function validateBundleReport(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) fail();
  const lines = text.split("\n");
  const once = (expected) => {
    if (lines.filter((line) => line === expected).length !== 1) fail();
  };
  once("TAP version 13");
  const results = lines.filter((line) => /^(?:not )?ok\b/.test(line));
  const expected = names.map((name, index) => `ok ${index + 1} - ${name}`);
  if (JSON.stringify(results) !== JSON.stringify(expected)) fail();
  if (/^\s*(?:not ok\b|Bail out!)/m.test(text)) fail();
  if (lines.filter((line) => /^\d+\.\./.test(line)).join() !== "1..5") fail();
  for (const [name, count] of [["tests", 5], ["suites", 0], ["pass", 5],
    ["fail", 0], ["cancelled", 0], ["skipped", 0], ["todo", 0]]) {
    const summary = lines.filter((line) => line.startsWith(`# ${name} `));
    if (summary.length !== 1 || summary[0] !== `# ${name} ${count}`) fail();
  }
  return names.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) fail();
  const bytes = readFileSync(process.argv[2]);
  if (bytes.length > 1024 * 1024) fail();
  validateBundleReport(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  console.log("[ci] all five exact bundle test identities passed");
}
