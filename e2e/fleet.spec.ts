import { expect, test, type Page } from "@playwright/test";

const observedAt = "2026-08-25T00:00:00.000Z";

function snapshot(data: unknown, sequence: number, header = String(sequence)) {
  return {
    json: {
      data,
      as_of_sequence: sequence,
      observed_at: observedAt,
      source: "bullet-kernel/sqlite-ledger",
    },
    contentType: "application/json",
    headers: { "x-bullet-as-of-sequence": header },
  };
}

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

async function mockStream(page: Page): Promise<void> {
  await page.route("**/api/v1/events**", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "no stream" }),
  );
}

test("an empty fleet renders zero rows verified at the watermark, never green", async ({ page }) => {
  await mockStream(page);
  await page.route("**/api/v1/fleet", (route) =>
    route.fulfill(snapshot({ authority_time: "2026-08-25T00:00:01.000Z", leases: [], ready_queue: [] }, 5)),
  );
  await page.goto("/#/fleet");
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
  await expect(page.getByTestId("fleet-leases-empty")).toContainText(
    "active leases: 0 rows (verified at sequence 5)",
  );
  await expect(page.getByTestId("fleet-ready-empty")).toContainText(
    "ready queue: 0 rows (verified at sequence 5)",
  );
  await expect(page.getByTestId("fleet-tagline")).toContainText("as_of_sequence 5");
  await expect(page.getByTestId("fleet-tagline")).toContainText("source bullet-kernel/sqlite-ledger");
  await expect(page.getByTestId("fleet-tagline")).toContainText(`observed_at ${observedAt}`);
  await expect(page.getByTestId("fleet-tagline")).toContainText(/freshness \d+s since observed_at/);
  await expect(page.getByTestId("fleet-tagline")).toContainText("projection published");
  await expect(page.getByTestId("surface-fleet").locator(".verified")).toHaveCount(0);
});

test("a failed fleet read renders unknown, not an empty list", async ({ page }) => {
  await mockStream(page);
  await page.route("**/api/v1/fleet", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "down" }),
  );
  await page.goto("/#/fleet");
  await expect(page.getByTestId("fleet-unknown")).toContainText(
    "unknown: Fleet: control plane unreachable (GET /api/v1/fleet failed: HTTP 500)",
  );
  await expect(page.getByTestId("fleet-tagline")).toContainText("projection unknown");
  await expect(page.getByTestId("fleet-leases-empty")).toHaveCount(0);
});

test("a lease row shows liveness judged by the store clock and its linkage", async ({ page }) => {
  await mockStream(page);
  await page.route("**/api/v1/fleet", (route) =>
    route.fulfill(
      snapshot(
        {
          authority_time: "2026-08-25T00:00:20.000Z",
          leases: [
            {
              variant_id: id("var", "1"),
              attempt_id: id("atm", "2"),
              fence: 3,
              runner_id: id("run", "3"),
              runner_epoch: 1,
              heartbeat_at: "2026-08-25T00:00:00.000Z",
              expires_at: "2026-08-25T00:00:15.000Z",
              ttl_seconds: 15,
              liveness: "expired",
              attempt_state: "running",
              work_package_id: id("wpk", "4"),
              mission_id: id("mis", "5"),
            },
          ],
          ready_queue: [],
        },
        9,
      ),
    ),
  );
  await page.goto("/#/fleet");
  await expect(page.getByTestId("fleet-leases-rows")).toContainText(id("atm", "2"));
  await expect(page.getByTestId("fleet-leases-rows")).toContainText("expired");
  await expect(page.getByTestId("fleet-summary")).toContainText("live 0 · expired 1 · unknown 0");
  await expect(page.getByTestId("fleet-authority-time")).toContainText("2026-08-25T00:00:20.000Z");
  await expect(page.getByTestId("fleet-ready-empty")).toContainText("ready queue: 0 rows (verified at sequence 9)");
});

test("a watermark header/body contradiction is unknown, not a rendered table", async ({ page }) => {
  await mockStream(page);
  await page.route("**/api/v1/fleet", (route) =>
    route.fulfill(snapshot({ authority_time: "2026-08-25T00:00:01.000Z", leases: [], ready_queue: [] }, 5, "6")),
  );
  await page.goto("/#/fleet");
  await expect(page.getByTestId("fleet-unknown")).toContainText("snapshot watermark header/body mismatch");
  await expect(page.getByTestId("fleet-leases-empty")).toHaveCount(0);
});
