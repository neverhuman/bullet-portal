import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:7420",
      "/health": "http://127.0.0.1:7420",
      "/openapi.yaml": "http://127.0.0.1:7420",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
