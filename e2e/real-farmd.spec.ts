import { expect, test } from "@playwright/test";

const environment = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const farmd = environment?.BULLET_FARMD_URL ?? "http://127.0.0.1:7420";
const bootstrap = environment?.BULLET_BOOTSTRAP_TOKEN;
const worker = environment?.BULLET_WORKER_TOKEN;

test.describe("real farmd command authority", () => {
  test("browser reconciles the exact command to durable UNKNOWN without green", async ({ page }) => {
    expect(bootstrap, "real lane must inject farmd's one-time token").toMatch(/^boot_[0-9a-f]{64}$/);
    expect(worker, "real lane must inject farmd's independent worker token").toMatch(
      /^wrk_[0-9a-f]{64}$/,
    );

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
    await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 0");
    await expect(page.getByRole("button", { name: "Submit durable demo command" })).toBeDisabled();
    await page.getByLabel("One-time bootstrap token").fill(bootstrap ?? "");
    await page.getByRole("button", { name: "Authenticate local session" }).click();
    await expect(page.getByTestId("auth-state")).toContainText("session material present");
    await expect(page.getByTestId("auth-state")).not.toHaveClass("verified");

    await page.getByRole("button", { name: "Submit durable demo command" }).click();
    await expect(page.getByTestId("phase")).toContainText("command phase: PENDING");
    await expect(page.getByTestId("phase")).toHaveClass("pending");
    await expect(page.getByTestId("command-id")).toContainText(/^cmd_[0-9a-f]{64}$/);
    const commandId = (await page.getByTestId("command-id").textContent())?.trim();
    expect(commandId).toMatch(/^cmd_[0-9a-f]{64}$/);
    await expect(page.getByTestId("command")).toContainText("run_demo");
    await expect(page.getByTestId("command")).toContainText("not recorded");
    await expect(page.getByTestId("stream-connection")).toContainText("live");
    await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 1");
    await page.waitForTimeout(400);
    await expect(page.getByTestId("phase")).toContainText("PENDING");
    await expect(page.getByTestId("phase")).not.toHaveClass("verified");

    const reconciled = await fetch(`${farmd}/internal/v1/commands/${commandId}/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker}` },
    });
    expect(reconciled.status).toBe(200);
    const settled = (await reconciled.json()) as {
      id: string;
      status: string;
      payload_digest: string;
      result: { command_id: string; payload_digest: string; code: string };
    };
    expect(settled.id).toBe(commandId);
    expect(settled.status).toBe("UNKNOWN");
    expect(settled.result).toMatchObject({
      command_id: commandId,
      payload_digest: settled.payload_digest,
      code: "EXECUTION_ADAPTER_UNAVAILABLE",
    });
    await expect(page.getByTestId("phase")).toContainText("UNKNOWN");
    await expect(page.getByTestId("phase")).toHaveClass("unknown");
    await expect(page.getByTestId("phase")).not.toHaveClass("verified");
    await expect(page.getByTestId("command-id")).toHaveText(commandId ?? "");
    await expect(page.getByTestId("command")).toContainText("EXECUTION_ADAPTER_UNAVAILABLE");
    await expect(page.getByTestId("command")).toContainText(commandId ?? "");
    await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 2");

    const removed = await fetch(`${farmd}/v1/demo/run`, { method: "POST" });
    expect(removed.status).toBe(410);
  });
});
