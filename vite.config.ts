import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const kernelProxy = {
  "/api/v1": "http://127.0.0.1:7420",
  "/health": "http://127.0.0.1:7420",
  "/openapi.yaml": "http://127.0.0.1:7420",
};

export default defineConfig(({ mode }) => {
  const configuredApi = loadEnv(mode, process.cwd(), "VITE_BULLET_API").VITE_BULLET_API;
  if (configuredApi) {
    throw new Error(
      "VITE_BULLET_API_UNSUPPORTED: Portal browser requests must use relative same-origin paths",
    );
  }
  return {
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
  };
});
