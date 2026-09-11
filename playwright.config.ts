import { defineConfig } from "@playwright/test";
import { requireRenderedHost } from "./ops/proof/rendered-host";

requireRenderedHost();

export default defineConfig({
  testDir: "e2e",
  testIgnore: "real-farmd.spec.ts",
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
