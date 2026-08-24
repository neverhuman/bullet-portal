import { expect, test } from "@playwright/test";

const environment = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const farmd = environment?.BULLET_FARMD_URL ?? "http://127.0.0.1:7420";
const bootstrap = environment?.BULLET_BOOTSTRAP_TOKEN;

test.describe("real farmd command authority", () => {
  test("browser bootstraps, submits with CSRF, and renders durable PENDING", async ({ page }) => {
    expect(bootstrap, "real lane must inject farmd's one-time token").toMatch(/^boot_[0-9a-f]{64}$/);

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

    await page.goto("/#/control-tower");
    await expect(page.getByRole("heading", { name: "Control Tower" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit durable demo command" })).toBeDisabled();
    await page.getByLabel("One-time bootstrap token").fill(bootstrap ?? "");
    await page.getByRole("button", { name: "Authenticate local session" }).click();
    await expect(page.getByTestId("auth-state")).toContainText("session material present");
    await expect(page.getByTestId("auth-state")).not.toHaveClass("verified");

    await page.getByRole("button", { name: "Submit durable demo command" }).click();
    await expect(page.getByTestId("phase")).toContainText("command phase: PENDING");
    await expect(page.getByTestId("phase")).toHaveClass("pending");
    await expect(page.getByTestId("command-id")).toContainText(/^cmd_[0-9a-f]{32}$/);
    await expect(page.getByTestId("command")).toContainText("run_demo");
    await expect(page.getByTestId("command")).toContainText("not recorded");
    await page.waitForTimeout(750);
    await expect(page.getByTestId("phase")).toContainText("PENDING");
    await expect(page.getByTestId("phase")).not.toHaveClass("verified");

    const removed = await fetch(`${farmd}/v1/demo/run`, { method: "POST" });
    expect(removed.status).toBe(410);
  });
});
