import { expect, test } from "@playwright/test";

const farmd =
  (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.BULLET_FARMD_URL ?? "http://127.0.0.1:7420";

test.describe("real farmd projections", () => {
  test("Control Tower, Mission Graph, Live Attempt, and Audit share sequences", async ({
    page,
  }) => {
    const ready = await fetch(`${farmd}/v1/ready`);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as {
      data: unknown;
      as_of_sequence: number;
      observed_at: string;
      source: string;
    };
    expect(readyBody.data).toBeNull();
    expect(readyBody.source).toBe("bullet-kernel/sqlite-ledger");
    expect(Number.isNaN(Date.parse(readyBody.observed_at))).toBeFalsy();
    expect(ready.headers.get("x-bullet-as-of-sequence")).toBe(
      String(readyBody.as_of_sequence),
    );

    const run = await fetch(`${farmd}/v1/demo/run`, { method: "POST" });
    expect(run.ok).toBeTruthy();
    const receipt = (await run.json()) as {
      mission_id: string;
      attempt_second_id: string;
      evidence_result: string;
    };
    expect(receipt.evidence_result).toBe("PASS");

    await page.goto("/#/control-tower");
    await expect(page.getByRole("heading", { name: "Control Tower" })).toBeVisible();
    await expect(page.getByText(/source: bullet-kernel\/sqlite-ledger via GET/).first()).toBeVisible();

    await page.goto("/#/mission-graph");
    await expect(page.getByTestId("mission-graph-projection")).toContainText(receipt.mission_id);
    await expect(page.getByTestId("surface-mission-graph")).toContainText(
      "source bullet-kernel/sqlite-ledger",
    );

    await page.goto("/#/live-attempt");
    await expect(page.getByTestId("live-attempt-projection")).toContainText(receipt.mission_id);

    await page.goto("/#/incidents-audit");
    await expect(page.getByTestId("incidents-audit-projection")).toContainText("effect_receipt");
  });
});
