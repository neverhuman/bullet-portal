import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  retries: 0,
  workers: 1,
  testMatch: "real-farmd.spec.ts",
  use: { baseURL: "http://127.0.0.1:5173", trace: "off", screenshot: "off", video: "off" },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
