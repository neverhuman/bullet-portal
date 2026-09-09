import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const urls = new Set();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) urls.add(match[1]);
  for (const match of text.matchAll(/<(https?:\/\/[^>\s]+)>/g)) urls.add(match[1]);
}
const external = [...urls].filter((url) => !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(url));
if (external.length === 0) throw new Error("ZERO_EXTERNAL_LINK_PARTITION");
const failed = [];
for (const url of external.sort()) {
  try {
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": "bullet-portal-link-check/1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 403 || response.status === 405) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": "bullet-portal-link-check/1" },
        signal: AbortSignal.timeout(20_000),
      });
    }
    if (!response.ok) failed.push(`${url} (${response.status})`);
  } catch (error) {
    failed.push(`${url} (${error instanceof Error ? error.message : "request failed"})`);
  }
}
if (failed.length > 0) throw new Error(`EXTERNAL_LINK_FAILURE:\n${failed.join("\n")}`);
console.log(`[ci] external links passed (${external.length})`);
