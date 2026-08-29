import { defineConfig } from "@playwright/test";

// The packaged lane has no preview server: farmd serves the built Portal at
// its own origin, so the browser base URL and the API origin are the same.
const packaged =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.BULLET_PACKAGED_URL ?? "http://127.0.0.1:7421";

export default defineConfig({
  testDir: "e2e",
  testMatch: ["real-farmd.spec.ts", "shift-brief.spec.ts"],
  use: { baseURL: packaged },
});
