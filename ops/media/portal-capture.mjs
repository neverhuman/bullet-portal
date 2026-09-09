// Walk the Control Tower against a farmd serving the ledger a real dogfood
// run wrote, and capture a numbered frame sequence. No fixtures, no mocks.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = process.env.PORTAL_ORIGIN ?? "http://127.0.0.1:4399";
const TOKEN = process.env.BULLET_BOOTSTRAP_TOKEN ?? "";
const OUT = process.env.CAPTURE_DIR ?? "/tmp/portal-capture";
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1920);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1200);

const SURFACES = [
  ["shift-brief", "Shift Brief", 3.0],
  ["control-tower", "Control Tower", 2.6],
  ["mission-graph", "Mission Graph", 2.6],
  ["live-attempt", "Live Attempt", 3.2],
  ["fleet", "Fleet", 2.2],
  ["merge-rail", "Merge Rail", 3.0],
  ["context-lineage", "Context Lineage", 2.4],
];

if (!TOKEN) {
  console.error("BULLET_BOOTSTRAP_TOKEN is required");
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
// Subpixel/LCD text rendering turns every glyph edge into a unique colour,
// which a 256-colour GIF cannot carry. Greyscale antialiasing with hinting
// off collapses the palette without softening the glyphs.
const browser = await chromium.launch({
  args: [
    "--disable-lcd-text",
    "--disable-font-subpixel-positioning",
    "--font-render-hinting=none",
    "--force-color-profile=srgb",
    "--disable-gpu",
  ],
});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const page = await context.newPage();
const frames = [];
let index = 0;

async function shot(hold) {
  const file = path.join(OUT, `f${String(index).padStart(4, "0")}.png`);
  await page.screenshot({ path: file, fullPage: false });
  frames.push({ file, hold });
  index += 1;
}

await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
const exchange = await page.evaluate(async (token) => {
  const response = await fetch("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap_token: token }),
    credentials: "same-origin",
  });
  return { status: response.status };
}, TOKEN);
console.log("bootstrap exchange:", exchange.status);
if (exchange.status !== 200) process.exit(3);

const notes = [];
for (const [id, label, hold] of SURFACES) {
  await page.goto(`${ORIGIN}/#/${id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await shot(hold);
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  if (scrollable > 120) {
    const steps = Math.min(6, Math.ceil(scrollable / (HEIGHT * 0.7)));
    for (let step = 1; step <= steps; step += 1) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }),
        Math.round((scrollable * step) / steps));
      await page.waitForTimeout(250);
      await shot(step === steps ? 1.8 : 0.9);
    }
  }
  notes.push({ surface: id, label, scrollable });
  console.log(`captured ${id} (+${scrollable}px scroll)`);
}

await writeFile(path.join(OUT, "frames.json"), JSON.stringify({ width: WIDTH, height: HEIGHT, frames, notes }, null, 2));
await browser.close();
console.log(`frames: ${frames.length}`);
