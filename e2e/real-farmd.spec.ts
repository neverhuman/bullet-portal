import { expect, test } from "@playwright/test";

const farmd = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.BULLET_FARMD_URL;

test.describe("real farmd projections", () => {
  test.skip(!farmd, "BULLET_FARMD_URL is required for the real-farmd lane");

  test("Control Tower, Mission Graph, Live Attempt, and Audit share sequences", async ({
    page,
  }) => {
    const base = farmd as string;
    const run = await fetch(`${base}/v1/demo/run`, { method: "POST" });
    expect(run.ok).toBeTruthy();
    const receipt = (await run.json()) as {
      mission_id: string;
      attempt_second_id: string;
      evidence_result: string;
    };
    expect(receipt.evidence_result).toBe("PASS");

    await page.goto("/#/control-tower");
    await expect(page.getByRole("heading", { name: "Control Tower" })).toBeVisible();

    await page.goto("/#/mission-graph");
    await expect(page.getByTestId("mission-graph-projection")).toContainText(receipt.mission_id);

    await page.goto("/#/live-attempt");
    await expect(page.getByTestId("live-attempt-projection")).toContainText(receipt.mission_id);

    await page.goto("/#/incidents-audit");
    await expect(page.getByTestId("incidents-audit-projection")).toContainText("effect_receipt");
  });
});
