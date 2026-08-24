import { expect, test, type Page } from "@playwright/test";

const demoReceipt = {
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
};

async function mockSnapshot(page: Page): Promise<void> {
  await page.route("**/v1/missions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: [], contentType: "application/json" });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/outbox", async (route) => {
    await route.fulfill({ json: { pending: [] }, contentType: "application/json" });
  });
  await page.route("**/v1/events**", async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "no stream" });
  });
}

async function mockHealthOk(page: Page): Promise<void> {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, contentType: "application/json" }),
  );
}

test("demo receipt verifies against a mocked ledger", async ({ page }) => {
  await mockSnapshot(page);
  await mockHealthOk(page);
  await page.route("**/v1/demo/run", (route) =>
    route.fulfill({ json: demoReceipt, contentType: "application/json" }),
  );

  await page.goto("/");
  await expect(page.getByTestId("health-probe")).toContainText("farmd /health: ok");
  await expect(page.getByTestId("stream-connection")).toContainText(
    "unknown (events stream unavailable)",
  );
  await expect(page.getByTestId("outbox-empty")).toContainText("outbox: empty (verified)");
  await page.getByRole("button", { name: "Run simulator demo" }).click();
  await expect(page.getByTestId("phase")).toContainText("mutation phase: verified");
  await expect(page.getByTestId("receipt")).toContainText("atm_stale");
  await expect(page.getByTestId("receipt")).toContainText("abc");
  await expect(page.getByTestId("receipt")).toContainText(
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  await expect(page.getByTestId("receipt")).toContainText("true");
});

test("pending is visible before the ledger confirms", async ({ page }) => {
  await mockSnapshot(page);
  await mockHealthOk(page);
  await page.route("**/v1/demo/run", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ json: demoReceipt, contentType: "application/json" });
  });

  await page.goto("/");
  const button = page.getByRole("button", { name: "Run simulator demo" });
  await button.click();
  await expect(page.getByTestId("phase")).toContainText("mutation phase: pending");
  await expect(page.getByTestId("phase")).toHaveClass("pending");
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("phase")).toContainText("mutation phase: verified");
  await expect(button).toBeEnabled();
});

test("a failed run renders failed with the error, never idle or verified", async ({ page }) => {
  await mockSnapshot(page);
  await mockHealthOk(page);
  await page.route("**/v1/demo/run", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Run simulator demo" }).click();
  await expect(page.getByTestId("phase")).toContainText("mutation phase: failed");
  await expect(page.getByTestId("phase")).toHaveClass("failed");
  await expect(page.getByTestId("mutation-error")).toContainText(
    "POST /v1/demo/run failed: HTTP 500",
  );
  await page.waitForTimeout(400);
  await expect(page.getByTestId("phase")).toContainText("mutation phase: failed");
});

test("the health probe reports unknown when /health fails", async ({ page }) => {
  await mockSnapshot(page);
  await page.route("**/health", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await expect(page.getByTestId("health-probe")).toContainText("unknown: GET /health failed");
  await expect(page.getByTestId("health-probe")).not.toContainText("healthy");
});

test("a failed missions read renders unknown, not an empty list", async ({ page }) => {
  await page.route("**/v1/missions", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "down" }),
  );
  await page.route("**/v1/outbox", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "down" }),
  );
  await page.route("**/v1/events**", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "no stream" }),
  );
  await page.route("**/health", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await expect(page.getByTestId("missions-unknown")).toContainText(
    "unknown: control plane unreachable (GET /v1/missions failed: HTTP 500)",
  );
  await expect(page.locator("text=No missions yet.")).toHaveCount(0);
  await expect(page.getByTestId("outbox-unknown")).toContainText("unknown");
});
