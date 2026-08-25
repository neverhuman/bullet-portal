import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const kernelProxy = {
  "/v1": "http://127.0.0.1:7420",
  "/health": "http://127.0.0.1:7420",
  "/openapi.yaml": "http://127.0.0.1:7420",
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: kernelProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: kernelProxy,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
