import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./external-links.mjs", import.meta.url));

async function fixture(t, documents, { initializeGit = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "portal-external-links-"));
  const observed = [];
  const server = createServer((request, response) => {
    observed.push({ method: request.method, path: request.url });
    if (request.url === "/disconnect") {
      request.socket.destroy();
      return;
    }
    let status = request.url.startsWith("/missing") ? 404 : 200;
    if (request.url === "/fallback-ok" && request.method === "HEAD") status = 403;
    if (request.url === "/fallback-fail") status = request.method === "HEAD" ? 405 : 404;
    response.writeHead(status).end();
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.2");
  await once(server, "listening");
  const base = `http://127.0.0.2:${server.address().port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  if (initializeGit) execFileSync("git", ["init", "--template=", "--quiet", root], { env });
  for (const [name, content] of Object.entries(documents(base))) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const run = () => new Promise((resolve, reject) => {
    execFile(process.execPath, [checker], { cwd: root, env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
  return { base, root, env, observed, run };
}

function assertFailure(result, reason) {
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(result.stderr, reason);
  assert.doesNotMatch(result.stdout, /external links passed/);
}

test("actual Git inventory checks reference variants, deduplicates and retains ignore policy", async (t) => {
  const f = await fixture(t, (base) => ({
    "README.md": `[inline](${base}/inline)\n<${base}/angle>\n[used][plain]\n[plain]: ${base}/plain\n`,
    "docs/with spaces.md": `[title]: ${base}/title "Title"\n   [indent]: ${base}/indent\n`,
    "docs/with\nnewline.md": `[multiline]:\n  ${base}/multiline 'Title'\n[duplicate]: ${base}/plain\n`,
    ".github/SUPPORT.md": `[angle-ref]: <${base}/angle-ref> "Angle"\r\n[escaped\\]label]: ${base}/escaped\r\n`,
    ".gitignore": "ignored.md\n",
    "ignored.md": `[ignored]: ${base}/missing-ignored\n`,
  }));
  execFileSync("git", ["add", "--", "README.md"], { cwd: f.root, env: f.env });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /external links passed \(8\)/);
  assert.deepEqual(f.observed, ["/angle", "/angle-ref", "/escaped", "/indent", "/inline", "/multiline", "/plain", "/title"]
    .map((path) => ({ method: "HEAD", path })));
});

for (const [label, definition] of [
  ["bare", (url) => `[ref]: ${url}`],
  ["titled", (url) => `  [ref]: ${url} "A title"`],
  ["next-line", (url) => `[ref]:\n  ${url}`],
  ["escaped-label", (url) => `[ref\\]label]: ${url}`],
]) test(`actual consumer rejects observed 404 from ${label} reference beside passing inline URL`, async (t) => {
  const f = await fixture(t, (base) => ({
    "README.md": `[inline](${base}/valid)\n[used][ref]\n\n${definition(`${base}/missing-reference`)}\n`,
  }));
  const result = await f.run();
  assertFailure(result, /EXTERNAL_LINK_FAILURE:/);
  assert.ok(result.stderr.includes(`${f.base}/missing-reference (404)`), result.stderr);
  assert.deepEqual(f.observed, [
    { method: "HEAD", path: "/missing-reference" }, { method: "HEAD", path: "/valid" },
  ]);
});

test("reference HEAD403 falls back to actual successful GET", async (t) => {
  const f = await fixture(t, (base) => ({ "README.md": `[ref]: ${base}/fallback-ok\n` }));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /external links passed \(1\)/);
  assert.deepEqual(f.observed, [
    { method: "HEAD", path: "/fallback-ok" }, { method: "GET", path: "/fallback-ok" },
  ]);
});

test("reference HEAD405 then actual GET404 remains failure", async (t) => {
  const f = await fixture(t, (base) => ({ "README.md": `[ref]: ${base}/fallback-fail\n` }));
  const result = await f.run();
  assertFailure(result, /EXTERNAL_LINK_FAILURE:/);
  assert.ok(result.stderr.includes(`${f.base}/fallback-fail (404)`), result.stderr);
  assert.deepEqual(f.observed, [
    { method: "HEAD", path: "/fallback-fail" }, { method: "GET", path: "/fallback-fail" },
  ]);
});

test("reference transport failure is preserved after an observed connection", async (t) => {
  const f = await fixture(t, (base) => ({ "README.md": `[ref]: ${base}/disconnect\n` }));
  const result = await f.run();
  assertFailure(result, /EXTERNAL_LINK_FAILURE:/);
  assert.ok(result.stderr.includes(`${f.base}/disconnect (fetch failed)`), result.stderr);
  assert.deepEqual(f.observed, [{ method: "HEAD", path: "/disconnect" }]);
});

test("localhost exclusions remain excluded and cannot make a zero partition pass", async (t) => {
  const f = await fixture(t, () => ({ "README.md": "[one]: http://127.0.0.1:1/local\n[two]: http://localhost:1/local\n" }));
  const result = await f.run();
  assertFailure(result, /ZERO_EXTERNAL_LINK_PARTITION/);
  assert.deepEqual(f.observed, []);
});

test("failed actual Git enumeration cannot report an external-link pass", async (t) => {
  const f = await fixture(t, (base) => ({ "README.md": `[ref]: ${base}/valid\n` }), { initializeGit: false });
  const result = await f.run();
  assertFailure(result, /not a git repository/);
  assert.deepEqual(f.observed, []);
});
