import { expect, test } from "@playwright/test";
import { reconcileComponent } from "./real-worker";
import type { BrowserContext, Page } from "@playwright/test";
import type { CommandStatus } from "../src/generated/api";
const environment = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const farmd = environment?.BULLET_FARMD_URL ?? "http://127.0.0.1:7420";
const bootstrap = environment?.BULLET_BOOTSTRAP_TOKEN;
const worker = environment?.BULLET_WORKER_TOKEN;

test.describe("real farmd command authority", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, baseURL }) => {
    expect(/^boot_[0-9a-f]{64}$/.test(bootstrap ?? ""), "private bootstrap fixture required").toBe(true);
    context = await browser.newContext({ baseURL });
    page = await context.newPage();
    await page.goto("/#/control-tower");
    await expect(page.getByRole("button", { name: "Submit durable coding command" })).toBeDisabled();
    await page.getByLabel("One-time bootstrap token").fill(bootstrap ?? "");
    await page.getByRole("button", { name: "Authenticate local session" }).click();
    await expect(page.getByTestId("auth-state")).toContainText("session material present");
    await expect(page.getByTestId("auth-state")).not.toHaveClass("verified");
    await page.getByRole("button", { name: "Check session", exact: true }).click();
    await expect(page.getByTestId("operator-session-identity")).toContainText("AUTHENTICATED");
  });

  test.afterAll(async () => { await context?.close(); });

  const read = (path: string) => page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    return { status: response.status, sequence: response.headers.get("x-bullet-as-of-sequence"),
      body: await response.json() };
  }, path);
  test("legacy operator routes are typed retired and a valid command remains inert", async () => {
    for (const path of ["ready", "outbox", "operator-snapshot", "commands", "events"]) {
      const denied = await fetch(`${farmd}/api/v1/${path}`);
      expect(denied.status, `anonymous ${path}`).toBe(401);
      expect(await denied.json()).toMatchObject({ code: "SESSION_REQUIRED" });
    }
    const before = await read("/api/v1/outbox");
    expect(before.status).toBe(200);
    const beforeBody = before.body;
    const beforeSequence = before.sequence;

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

    const after = await read("/api/v1/outbox");
    expect(after.status).toBe(200);
    expect(after.sequence).toBe(beforeSequence);
    const afterBody = after.body;
    expect(afterBody.data).toEqual(beforeBody.data);
    expect(afterBody.source).toBe(beforeBody.source);
    expect(String(beforeBody.as_of_sequence)).toBe(beforeSequence);
    expect(afterBody.as_of_sequence).toBe(beforeBody.as_of_sequence);
    expect(typeof beforeBody.observed_at).toBe("string");
    expect(typeof afterBody.observed_at).toBe("string");
  });

  test("browser reconciles the exact command to durable UNKNOWN without green", async () => {
    test.setTimeout(800_000);
    expect(/^wrk_[0-9a-f]{64}$/.test(worker ?? ""), "independent worker token fixture required").toBe(true);

    const ready = await read("/api/v1/ready");
    expect(ready.status).toBe(200);
    const readyBody = ready.body as {
      data: unknown;
      as_of_sequence: number;
      observed_at: string;
      source: string;
    };
    expect(readyBody.data).toBeNull();
    expect(readyBody.source).toBe("bullet-kernel/sqlite-ledger");
    expect(Number.isNaN(Date.parse(readyBody.observed_at))).toBeFalsy();
    expect(ready.sequence).toBe(
      String(readyBody.as_of_sequence),
    );

    const initialSequence = readyBody.as_of_sequence;
    await page.goto("/#/control-tower");
    await expect(page.getByRole("heading", { name: "Control Tower" })).toBeVisible();
    // Component fixture submission exercises the real authenticated ingress. This
    // demo kind is a component fixture, not an operator product button or provider evidence.
    const admitted = await page.evaluate(async () => {
      const csrf = sessionStorage.getItem("bullet-farm.csrf.v1");
      if (!csrf) throw new Error("admitted CSRF fixture missing");
      const response = await fetch("/api/v1/commands", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bullet-csrf": csrf },
        body: JSON.stringify({ idempotency_key: "connected-component-command", kind: "run_demo", payload: {} }),
      });
      return { status: response.status, body: await response.json() as CommandStatus };
    });
    expect(admitted.status).toBe(202);
    const commandId = admitted.body.id;
    expect(commandId).toMatch(/^cmd_[0-9a-f]{64}$/);
    expect(admitted.body).toMatchObject({ status: "PENDING", result: null });
    // No local submission journal: recover the same durable command from its owner.
    await page.reload();
    await page.getByRole("button", { name: "Show command history" }).click();
    const history = page.getByRole("region", { name: "Command history", exact: true });
    await history.getByRole("button", { name: commandId, exact: true }).click();
    const card = history.getByTestId("command");
    await expect(card.getByTestId("command-id")).toHaveText(commandId);
    await expect(card.locator(".pending")).toHaveText("PENDING");
    await expect(card).toContainText("run_demo");
    await expect(card).toContainText("not recorded");
    await expect(page.getByTestId("stream-connection")).toContainText("live");
    await expect(page.getByTestId("as-of-sequence")).toHaveText(`as_of_sequence: ${initialSequence + 1}`);
    await page.waitForTimeout(400);
    await expect(card.locator(".pending")).toHaveText("PENDING");
    await expect(card.locator(".verified")).toHaveCount(0);

    const retired = await fetch(`${farmd}/internal/v1/commands/${commandId}/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker}` },
    });
    expect(retired.status).toBe(410);
    expect(await retired.json()).toMatchObject({ code: "WORKLOAD_API_UDS_REQUIRED" });
    const readCommand = () => page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/commands/${id}`, { credentials: "same-origin" });
      return { status: response.status, body: await response.json() as CommandStatus };
    }, commandId);
    const pendingResponse = await readCommand();
    expect(pendingResponse.status).toBe(200);
    const pending = pendingResponse.body;
    expect(pending).toMatchObject({ id: commandId, status: "PENDING", result: null });
    const inert = await read("/api/v1/outbox");
    expect(inert.sequence).toBe(String(initialSequence + 1));

    await reconcileComponent(commandId, pending, readCommand);
    await history.getByRole("button", { name: "Refresh history" }).click();
    await expect(card.locator(".unknown")).toHaveText("UNKNOWN");
    await expect(card.getByTestId("command-id")).toHaveText(commandId);
    await expect(card).toContainText("COMPONENT_PROOF_NOT_TRANSACTION_ELIGIBLE");
    await expect(card).toContainText(commandId);
    await expect(card.locator(".verified")).toHaveCount(0);
    await expect(page.getByTestId("as-of-sequence")).toHaveText(`as_of_sequence: ${initialSequence + 3}`);

    const removed = await fetch(`${farmd}/api/v1/demo/run`, { method: "POST" });
    expect(removed.status).toBe(410);
  });

  test("projection routes answer from one atomic read and the browser renders zero rows as verified, not green", async () => {
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
      const response = await read(route);
      expect(response.status, route).toBe(200);
      const body = response.body as {
        data: Record<string, unknown>;
        as_of_sequence: number;
        observed_at: string;
        source: string;
      };
      expect(body.source).toBe("bullet-kernel/sqlite-ledger");
      expect(Number.isNaN(Date.parse(body.observed_at))).toBeFalsy();
      expect(response.sequence).toBe(String(body.as_of_sequence));
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
