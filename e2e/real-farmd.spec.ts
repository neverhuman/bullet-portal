import { expect, test } from "@playwright/test";

const environment = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const farmd = environment?.BULLET_FARMD_URL ?? "http://127.0.0.1:7420";
const bootstrap = environment?.BULLET_BOOTSTRAP_TOKEN;
const worker = environment?.BULLET_WORKER_TOKEN;

test.describe("real farmd command authority", () => {
  test("legacy operator routes are typed retired and a valid command remains inert", async () => {
    const before = await fetch(`${farmd}/api/v1/outbox`);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    const beforeSequence = before.headers.get("x-bullet-as-of-sequence");

    for (const [method, path, body] of [
      ["GET", "/v1/missions", undefined],
      [
        "POST",
        "/v1/commands",
        JSON.stringify({ idempotency_key: "legacy-must-be-inert", kind: "run_demo", payload: {} }),
      ],
    ] as const) {
      const response = await fetch(`${farmd}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body,
      });
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      const problem = (await response.json()) as {
        code: string;
        status: number;
        retryable: boolean;
      };
      expect(problem).toMatchObject({
        code: "API_VERSION_RETIRED",
        status: 410,
        retryable: false,
      });
    }

    const after = await fetch(`${farmd}/api/v1/outbox`);
    expect(after.status).toBe(200);
    expect(after.headers.get("x-bullet-as-of-sequence")).toBe(beforeSequence);
    const afterBody = await after.json();
    expect(afterBody.data).toEqual(beforeBody.data);
    expect(afterBody.source).toBe(beforeBody.source);
    expect(String(beforeBody.as_of_sequence)).toBe(beforeSequence);
    expect(afterBody.as_of_sequence).toBe(beforeBody.as_of_sequence);
    expect(typeof beforeBody.observed_at).toBe("string");
    expect(typeof afterBody.observed_at).toBe("string");
  });

  test("browser reconciles the exact command to durable UNKNOWN without green", async ({ page }) => {
    expect(bootstrap, "real lane must inject farmd's one-time token").toMatch(/^boot_[0-9a-f]{64}$/);
    expect(worker, "real lane must inject farmd's independent worker token").toMatch(
      /^wrk_[0-9a-f]{64}$/,
    );

    const ready = await fetch(`${farmd}/api/v1/ready`);
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
    await expect(page.getByTestId("command").locator(".verified")).toHaveCount(0);
    await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 2");

    const removed = await fetch(`${farmd}/api/v1/demo/run`, { method: "POST" });
    expect(removed.status).toBe(410);
  });

  test("projection routes answer from one atomic read and the browser renders zero rows as verified, not green", async ({ page }) => {
    const routes = [
      "/api/v1/fleet",
      "/api/v1/sessions",
      "/api/v1/context-lineage",
      "/api/v1/merge-rail",
      "/api/v1/quality-lab",
      "/api/v1/audit",
    ];
    const watermarks: number[] = [];
    for (const route of routes) {
      const response = await fetch(`${farmd}${route}`);
      expect(response.status, route).toBe(200);
      const body = (await response.json()) as {
        data: Record<string, unknown>;
        as_of_sequence: number;
        observed_at: string;
        source: string;
      };
      expect(body.source).toBe("bullet-kernel/sqlite-ledger");
      expect(Number.isNaN(Date.parse(body.observed_at))).toBeFalsy();
      expect(response.headers.get("x-bullet-as-of-sequence")).toBe(String(body.as_of_sequence));
      watermarks.push(body.as_of_sequence);
    }
    expect(new Set(watermarks).size).toBe(1);

    await page.goto("/#/fleet");
    await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
    await expect(page.getByTestId("fleet-leases-empty")).toContainText(
      /active leases: 0 rows \(verified at sequence \d+\)/,
    );
    await expect(page.getByTestId("fleet-tagline")).toContainText("source bullet-kernel/sqlite-ledger");
    await expect(page.getByTestId("fleet-tagline")).toContainText("projection published");
    await expect(page.getByTestId("surface-fleet").locator(".verified")).toHaveCount(0);

    await page.goto("/#/context-lineage");
    await expect(page.getByRole("heading", { name: "Context Lineage" })).toBeVisible();
    await expect(page.getByTestId("context-lineage-capsules-empty")).toContainText(
      /context capsules: 0 rows \(verified at sequence \d+\)/,
    );
    await expect(page.getByTestId("context-lineage-summary")).toContainText(
      "raw objective and package title unavailable (digests only)",
    );
    await expect(page.getByTestId("context-lineage-summary")).toContainText(
      "no successor lineage claimed",
    );
    await expect(page.getByTestId("surface-context-lineage").locator(".verified")).toHaveCount(0);

    await page.goto("/#/incidents-audit");
    await expect(page.getByTestId("incidents-audit-summary")).toContainText(
      `latest_sequence ${watermarks[0]}`,
    );
    await expect(page.getByTestId("incidents-audit-events-rows")).toBeVisible();

    await page.goto("/#/quota-capacity");
    await expect(page.getByTestId("quota-capacity-unknown")).toContainText(
      "no ledger subject exists for this surface yet",
    );
  });
});
