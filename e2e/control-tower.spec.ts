import { expect, test, type Page } from "@playwright/test";

const observedAt = "2026-08-24T22:00:00.000Z";

function eventId(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

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

async function mockSnapshot(page: Page): Promise<void> {
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
}

async function mockHealthOk(page: Page): Promise<void> {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, contentType: "application/json" }),
  );
}

test("the health probe reports unknown when /health fails", async ({ page }) => {
  await mockSnapshot(page);
  await page.route("**/health", (route) => route.abort("connectionrefused"));

  await page.goto("/#/control-tower");
  await expect(page.getByTestId("health-probe")).toContainText("unknown: GET /health failed");
  await expect(page.getByTestId("health-probe")).not.toContainText("healthy");
});

test("a failed missions read renders unknown, not an empty list", async ({ page }) => {
  await page.route("**/api/v1/missions", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "down" }),
  );
  await page.route("**/api/v1/outbox", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "down" }),
  );
  await page.route("**/api/v1/events**", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "no stream" }),
  );
  await page.route("**/health", (route) => route.abort("connectionrefused"));

  await page.goto("/#/control-tower");
  await expect(page.getByTestId("missions-unknown")).toContainText(
    "unknown: control plane unreachable (GET /api/v1/missions failed: HTTP 500)",
  );
  await expect(page.locator("text=No missions yet.")).toHaveCount(0);
  await expect(page.getByTestId("outbox-unknown")).toContainText("unknown");
});

test("the event stream advances as_of_sequence from default EventEnvelopes", async ({ page }) => {
  await page.route("**/api/v1/missions", (route) =>
    route.fulfill(snapshot([])),
  );
  await page.route("**/api/v1/outbox", (route) =>
    route.fulfill(snapshot({ items: [] })),
  );
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, contentType: "application/json" }),
  );
  const at = new Date().toISOString();
  const frames = [
    `id: 1\ndata: ${JSON.stringify({ id: eventId(1), seq: 1, at, kind: "candidate_prepared", body: "{}" })}\n\n`,
    ": keep-alive\n\n",
    `id: 2\ndata: ${JSON.stringify({ id: eventId(2), seq: 2, at, kind: "effect_receipt", body: "{}" })}\n\n`,
  ].join("");
  await page.route("**/api/v1/events**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: frames }),
  );

  await page.goto("/#/control-tower");
  await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 2");
  await expect(page.getByTestId("projection-lag")).toContainText(/projection lag: \d+s/);
  await expect(page.getByTestId("stream-connection")).toContainText("reconnecting");
});

test("a 1,2,4 gap survives malformed snapshot recovery until watermark 4", async ({ page }) => {
  await page.clock.install();
  let gapEmitted = false;
  let missionRecoveries = 0;
  let outboxRecoveries = 0;
  await page.route("**/api/v1/missions", (route) => {
    if (!gapEmitted) {
      return route.fulfill(snapshot([]));
    }
    missionRecoveries += 1;
    if (missionRecoveries === 1) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[" });
    }
    return route.fulfill(snapshot([], 4));
  });
  await page.route("**/api/v1/outbox", (route) => {
    if (!gapEmitted) {
      return route.fulfill(snapshot({ items: [] }));
    }
    outboxRecoveries += 1;
    if (outboxRecoveries === 1) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{" });
    }
    return route.fulfill(snapshot({ items: [] }, 4));
  });
  await mockHealthOk(page);

  const requests: { url: string; lastEventId: string | undefined }[] = [];
  let reconnectSeen: (() => void) | null = null;
  const sawReconnect = new Promise<void>((resolve) => {
    reconnectSeen = resolve;
  });
  await page.route("**/api/v1/events**", async (route) => {
    const request = route.request();
    requests.push({ url: request.url(), lastEventId: request.headers()["last-event-id"] });
    if (requests.length === 1) {
      gapEmitted = true;
      const at = new Date().toISOString();
      const frames = [1, 2, 4]
        .map(
          (seq) =>
            `id: ${seq}\ndata: ${JSON.stringify({ id: eventId(seq), seq, at, kind: "test", body: "{}" })}\n\n`,
        )
        .join("");
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: frames });
      return;
    }
    reconnectSeen?.();
    await new Promise<void>(() => {});
  });

  await page.goto("/#/control-tower");
  await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 2");
  await expect(page.getByTestId("stale-badge")).toHaveText("STALE");
  await expect(page.getByTestId("missions-unknown")).toContainText("invalid JSON body");
  await expect(page.getByTestId("outbox-unknown")).toContainText("invalid JSON body");
  expect(requests[0]?.url).toContain("/api/v1/events?after=0");
  expect(requests[0]?.lastEventId).toBeUndefined();

  await page.clock.fastForward(10_001);
  await sawReconnect;
  await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 4");
  await expect(page.getByTestId("stale-badge")).toHaveCount(0);
  expect(requests[1]?.url).toMatch(/\/api\/v1\/events$/);
  expect(requests[1]?.lastEventId).toBe("4");
});

test("an event-retention 410 rebases from a covering snapshot before reconnect", async ({
  page,
}) => {
  await page.clock.install();
  let retentionGap = false;
  const snapshotSequence = (): number => (retentionGap ? 8 : 0);
  await page.route("**/api/v1/missions", (route) =>
    route.fulfill(snapshot([], snapshotSequence())),
  );
  await page.route("**/api/v1/outbox", (route) =>
    route.fulfill(snapshot({ items: [] }, snapshotSequence())),
  );
  await mockHealthOk(page);

  const requests: { url: string; lastEventId: string | undefined }[] = [];
  let reconnectSeen: (() => void) | null = null;
  const sawReconnect = new Promise<void>((resolve) => {
    reconnectSeen = resolve;
  });
  await page.route("**/api/v1/events**", async (route) => {
    const request = route.request();
    requests.push({ url: request.url(), lastEventId: request.headers()["last-event-id"] });
    if (requests.length === 1) {
      retentionGap = true;
      await route.fulfill({
        status: 410,
        contentType: "application/problem+json",
        body: '{"code":"REPLAY_UNAVAILABLE"}',
      });
      return;
    }
    reconnectSeen?.();
    await new Promise<void>(() => {});
  });

  await page.goto("/#/control-tower");
  await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 0");
  await expect(page.getByTestId("stale-badge")).toHaveText("STALE");
  expect(requests[0]?.url).toContain("/api/v1/events?after=0");
  expect(requests[0]?.lastEventId).toBeUndefined();

  await page.clock.fastForward(10_001);
  await sawReconnect;
  await expect(page.getByTestId("as-of-sequence")).toContainText("as_of_sequence: 8");
  await expect(page.getByTestId("stale-badge")).toHaveCount(0);
  expect(requests[1]?.url).toMatch(/\/api\/v1\/events$/);
  expect(requests[1]?.lastEventId).toBe("8");
});

test("an unprojected surface names its missing ledger subject, not an empty success list", async ({ page }) => {
  await mockSnapshot(page);
  await mockHealthOk(page);
  await page.goto("/#/quota-capacity");
  await expect(page.getByTestId("quota-capacity-unknown")).toContainText(
    "unknown: Quota and Capacity: no ledger subject exists for this surface yet: budget/quota reservations",
  );
  await expect(page.getByTestId("quota-capacity-unknown")).toContainText("V1-S6");
  await expect(page.getByText("No quota yet.")).toHaveCount(0);
  await expect(page.getByTestId("surface-quota-capacity").locator(".verified")).toHaveCount(0);
});
