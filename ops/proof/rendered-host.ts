import { hostname } from "node:os";
import process from "node:process";

// This restricts where browser tooling runs. It grants no operator, provider,
// release or execution authority; those subjects need their own admission.
export function requireRenderedHost(): void {
  validateRenderedHost(hostname(), process.platform, process.env);
}

export function validateRenderedHost(host: string, platform: string, environment: NodeJS.ProcessEnv): void {
  if (
    host !== "xbabe2" ||
    platform !== "linux" ||
    Object.hasOwn(environment, "CI") ||
    Object.hasOwn(environment, "GITHUB_ACTIONS")
  ) {
    throw new Error(
      "RENDERED_HOST_REQUIRED: run Tuiwright and Playwright locally on xbabe2, outside CI",
    );
  }
}
