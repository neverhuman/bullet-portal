import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
if (files.length === 0) throw new Error("ZERO_DOC_PARTITION: no tracked Markdown files");

const missing = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    target = decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
    if (!target) continue;
    const absolute = resolve(dirname(file), target);
    if (!existsSync(absolute) || (!statSync(absolute).isFile() && !statSync(absolute).isDirectory())) {
      missing.push(`${file} -> ${match[1]}`);
    }
  }
}
if (missing.length > 0) throw new Error(`BROKEN_RELATIVE_LINKS:\n${missing.join("\n")}`);
console.log(`[ci] documentation links passed (${files.length} Markdown files)`);
