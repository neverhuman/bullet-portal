import type { Page } from "@playwright/test";

export const sessionHeaders = { "x-bullet-session-id": `sid_${"2".repeat(64)}` };

/** Synthetic owner for mocked rendering only; no installed authentication claim. */
export async function mockOwner({ page }: { page: Page }): Promise<void> {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: { status: "AUTHENTICATED", operator_id: `opr_${"1".repeat(64)}`,
      session_id: sessionHeaders["x-bullet-session-id"],
      issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" },
  }));
}
