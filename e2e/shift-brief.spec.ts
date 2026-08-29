import { expect, test, type Page } from "@playwright/test";

const observedAt = "2026-08-27T11:00:00.000Z";

function snapshot(data: unknown, sequence = 0) {
  return {
    json: {
      data,
      as_of_sequence: sequence,
      observed_at: observedAt,
      source: "bullet-kernel/sqlite-ledger",
    },
    contentType: "application/json",
    headers: { "x-bullet-as-of-sequence": String(sequence) },
  };
}

async function refuseFarmd(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.route("**/health", (route) => route.abort("connectionrefused"));
}

async function mockControlTower(page: Page): Promise<void> {
  await page.route("**/api/v1/missions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(snapshot([]));
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/outbox", async (route) => {
    await route.fulfill(snapshot({ items: [] }));
  });
  await page.route("**/api/v1/events**", async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "no stream" });
  });
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, contentType: "application/json" }),
  );
}

test("root hashes open Shift Brief and never paint verified", async ({ page }) => {
  await refuseFarmd(page);
  for (const path of ["/", "/#", "/#/"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Shift Brief" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Control Tower" })).toHaveCount(0);
    await expect(page.getByTestId("nav-shift-brief")).toHaveClass(/nav-current/);
    await expect(page.getByTestId("shift-brief").locator(".verified")).toHaveCount(0);
    await expect(page.getByTestId("shift-brief-decision")).toHaveClass(/unknown/);
  }
});

test("six no-subject surfaces stay unknown and never paint verified", async ({ page }) => {
  await refuseFarmd(page);
  const unknown = [
    ["cognitive-router", "Cognitive Router"],
    ["fusion-lab", "Fusion Lab"],
    ["quota-capacity", "Quota and Capacity"],
    ["struggle-cockpit", "Struggle and Escalation"],
    ["behavior-center", "Behavior Center"],
    ["workspace-hygiene", "Workspace and Git Hygiene"],
  ] as const;
  for (const [id, title] of unknown) {
    await page.goto(`/#/${id}`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByTestId(`${id}-unknown`)).toHaveClass(/unknown/);
    await expect(page.getByTestId(`surface-${id}`).locator(".verified")).toHaveCount(0);
  }
});

test("unknown hash renders the explicit not-found view", async ({ page }) => {
  await refuseFarmd(page);
  await page.goto("/#/no-such-surface");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Control Tower" })).toHaveCount(0);
  await expect(page.getByTestId("shift-brief")).toHaveCount(0);
  await expect(page.getByTestId("not-found")).toHaveClass(/card/);
  await expect(page.getByRole("link", { name: "Open Shift Brief" })).toHaveCSS(
    "color",
    "rgb(169, 199, 255)",
  );
  await expect(page.locator(".nav-current")).toHaveCount(0);
  await expect(page.locator(".verified")).toHaveCount(0);
});

test("Control Tower remains the #/control-tower deep link", async ({ page }) => {
  await mockControlTower(page);
  await page.goto("/#/control-tower");
  await expect(page.getByRole("heading", { name: "Control Tower" })).toBeVisible();
  await expect(page.getByTestId("shift-brief")).toHaveCount(0);
  await expect(page.getByTestId("nav-control-tower")).toHaveClass(/nav-current/);
});
