import { expect, test } from "@playwright/test";

test("unknown stays unknown and demo receipt verifies", async ({ page }) => {
  await page.route("**/v1/missions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: [],
        contentType: "application/json",
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/demo/run", async (route) => {
    await route.fulfill({
      json: {
        mission_id: "mis_demo",
        plan_hash: "abc",
        fence: 1,
        attempt_id: "atm_live",
        stale_attempt_id: "atm_stale",
        candidate_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        evidence_result: "PASS",
        effect_outcome: "verified",
        materialize_idempotent: true,
        stale_refused: true,
      },
      contentType: "application/json",
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("unknown-probe")).toContainText("unknown");
  await expect(page.getByTestId("unknown-probe")).not.toContainText("healthy");
  await page.getByRole("button", { name: "Run simulator demo" }).click();
  await expect(page.getByTestId("phase")).toContainText("verified");
  await expect(page.getByTestId("receipt")).toContainText("atm_stale");
  await expect(page.getByTestId("receipt")).toContainText("true");
});
