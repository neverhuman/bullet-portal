import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const DEFAULT_KERNEL_PROXY = "http://127.0.0.1:7420";

function kernelProxyTarget(): string {
  const configured = process.env.BULLET_FARMD_TEST_PROXY;
  if (configured === undefined) {
    return DEFAULT_KERNEL_PROXY;
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("BULLET_FARMD_TEST_PROXY_INVALID: expected numeric loopback HTTP origin");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("BULLET_FARMD_TEST_PROXY_INVALID: expected numeric loopback HTTP origin");
  }
  return parsed.origin;
}

export default defineConfig(({ mode }) => {
  const configuredApi = loadEnv(mode, process.cwd(), "VITE_BULLET_API").VITE_BULLET_API;
  if (configuredApi) {
    throw new Error(
      "VITE_BULLET_API_UNSUPPORTED: Portal browser requests must use relative same-origin paths",
    );
  }
  const proxyTarget = kernelProxyTarget();
  const kernelProxy = {
    "/api/v1": proxyTarget,
    "/health": proxyTarget,
    "/openapi.yaml": proxyTarget,
  };
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
