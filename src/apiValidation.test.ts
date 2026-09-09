import { describe, expect, it } from "vitest";
import {
  isBootstrapResponse,
  isDemoReceipt,
  isEventEnvelope,
  isHealth,
  isMission,
  isMissionList,
  isMissionView,
  isOutboxView,
  isProblem,
  isReadyView,
  isRfc3339,
} from "./apiValidation";

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

const mission = {
  id: id("mis", "1"),
  organization_id: id("org", "2"),
  repository_id: id("rep", "3"),
  title: "Mission",
  objective: "Prove exact subjects",
  acceptance_contract_id: id("acc", "4"),
  state: "PLANNED",
};

const workPackage = {
  id: id("wpk", "5"),
  mission_id: mission.id,
  plan_revision_id: id("pln", "6"),
  task_class: "feature_implementation",
  title: "Validate subjects",
  state: "READY",
};

const ready = {
  work_package_id: workPackage.id,
  mission_id: mission.id,
  variant_id: id("var", "7"),
  title: workPackage.title,
  enqueued_at: "2026-08-25T00:00:00Z",
};

function invalidSubjects(prefix: string): string[] {
  return [
    `${prefix}_${"a".repeat(32)}`,
    `${prefix}_${"A".repeat(64)}`,
    id("cmd", "b"),
  ];
}

const AT = "2026-08-25T00:00:00.000Z";
const EVENT_ID = "a".repeat(64);
const CSRF_TOKEN = `csrf_${"b".repeat(64)}`;

const event = {
  id: EVENT_ID,
  seq: 1,
  at: AT,
  kind: "mission_materialized",
  body: "{}",
};

const outbox = {
  items: [
    {
      seq: 1,
      kind: "dispatch_attempt",
      payload: "{}",
      phase: "pending",
      delivered_at: null,
      acked_at: null,
    },
  ],
};

const problem = {
  type: "https://bullet.farm/problems/csrf-invalid",
  title: "Invalid CSRF token",
  status: 403,
  detail: "The CSRF token is not bound to the active browser session.",
  instance: "urn:bullet:request:req_deadbeefdeadbeef",
  code: "CSRF_INVALID",
  request_id: "req_deadbeefdeadbeef",
  correlation_id: "corr_deadbeefdeadbeef",
  retryable: false,
  repair: "Exchange a new bootstrap token.",
};

const demoReceipt = {
  mission_id: mission.id,
  plan_hash: `blake3:${"d".repeat(64)}`,
  attempt_id: id("atm", "e"),
  attempt_second_id: id("atm", "f"),
  stale_attempt_id: id("atm", "0"),
  candidate_head: "1".repeat(40),
  evidence_result: "PASS",
  effect_outcome: "APPLIED",
  effect_unknown_outcome: "NOT_DISPATCHED",
  fence_first: 1,
  fence_second: 2,
  materialize_idempotent: true,
  stale_refused: true,
};

describe("public projection subject validation", () => {
  it("accepts exact committed-Kernel Mission, WorkPackage, and Ready subjects", () => {
    expect(isMission(mission)).toBe(true);
    expect(isMissionList([mission])).toBe(true);
    expect(isMissionView({ mission, packages: [workPackage], fence: 2 })).toBe(true);
    expect(isReadyView(ready)).toBe(true);
  });

  it("rejects legacy-width, uppercase, and wrong-prefix Mission subjects", () => {
    for (const [field, prefix] of [
      ["id", "mis"],
      ["organization_id", "org"],
      ["repository_id", "rep"],
      ["acceptance_contract_id", "acc"],
    ] as const) {
      for (const subject of invalidSubjects(prefix)) {
        expect(isMission({ ...mission, [field]: subject })).toBe(false);
      }
    }
  });

  it("rejects legacy-width, uppercase, and wrong-prefix package and ready subjects", () => {
    for (const [field, prefix] of [
      ["id", "wpk"],
      ["mission_id", "mis"],
      ["plan_revision_id", "pln"],
    ] as const) {
      for (const subject of invalidSubjects(prefix)) {
        expect(
          isMissionView({
            mission,
            packages: [{ ...workPackage, [field]: subject }],
            fence: 2,
          }),
        ).toBe(false);
      }
    }
    for (const [field, prefix] of [
      ["work_package_id", "wpk"],
      ["mission_id", "mis"],
      ["variant_id", "var"],
    ] as const) {
      for (const subject of invalidSubjects(prefix)) {
        expect(isReadyView({ ...ready, [field]: subject })).toBe(false);
      }
    }
  });

  it("rejects unknown keys at every consumed subject-bearing object boundary", () => {
    expect(isMission({ ...mission, optimistic: true })).toBe(false);
    expect(isMissionView({ mission, packages: [workPackage], fence: 2, optimistic: true })).toBe(
      false,
    );
    expect(
      isMissionView({
        mission,
        packages: [{ ...workPackage, optimistic: true }],
        fence: 2,
      }),
    ).toBe(false);
    expect(isReadyView({ ...ready, optimistic: true })).toBe(false);
  });

  it("rejects a negative durable MissionView fence", () => {
    expect(isMissionView({ mission, packages: [workPackage], fence: -1 })).toBe(false);
  });
});

describe("generated public response DTO validators", () => {
  it("accepts the exact response shapes farmd emits", () => {
    expect(isEventEnvelope(event)).toBe(true);
    expect(isHealth({ status: "ok" })).toBe(true);
    expect(
      isHealth({
        status: "ok",
        portal: `blake3:${"c".repeat(64)}`,
        reap: { last_run_at: AT, reclaimed: 2 },
      }),
    ).toBe(true);
    expect(isOutboxView(outbox)).toBe(true);
    expect(
      isBootstrapResponse({
        status: "AUTHENTICATED",
        csrf_token: CSRF_TOKEN,
        expires_in_seconds: 28_800,
      }),
    ).toBe(true);
    expect(isProblem(problem)).toBe(true);
  });

  it("rejects unknown fields at every newly rooted object boundary", () => {
    expect(isEventEnvelope({ ...event, verified: true })).toBe(false);
    expect(isHealth({ status: "ok", healthy: true })).toBe(false);
    expect(
      isHealth({ status: "ok", reap: { last_run_at: AT, reclaimed: 0, healthy: true } }),
    ).toBe(false);
    expect(isOutboxView({ ...outbox, healthy: true })).toBe(false);
    expect(
      isOutboxView({ items: [{ ...outbox.items[0], delivered: true }] }),
    ).toBe(false);
    expect(
      isBootstrapResponse({
        status: "AUTHENTICATED",
        csrf_token: CSRF_TOKEN,
        expires_in_seconds: 28_800,
        bearer_token: "must not be accepted",
      }),
    ).toBe(false);
    expect(isProblem({ ...problem, stack: "must not be accepted" })).toBe(false);
  });

  it("rejects malformed EventEnvelope subjects and timestamps", () => {
    for (const invalid of [
      { ...event, id: "A".repeat(64) },
      { ...event, id: "a".repeat(63) },
      { ...event, seq: 0 },
      { ...event, seq: 1.5 },
      { ...event, seq: Number.MAX_SAFE_INTEGER + 1 },
      { ...event, kind: "" },
      { ...event, at: "2026-02-30T00:00:00Z" },
      { ...event, at: "2026-08-25" },
      { ...event, at: "2026-08-25T00:00:00+24:00" },
    ]) {
      expect(isEventEnvelope(invalid)).toBe(false);
    }
  });

  it("rejects out-of-catalog, unsafe, and malformed nested values", () => {
    expect(isOutboxView({ items: [{ ...outbox.items[0], phase: "green" }] })).toBe(false);
    expect(isOutboxView({ items: [{ ...outbox.items[0], seq: 0 }] })).toBe(false);
    expect(
      isOutboxView({ items: [{ ...outbox.items[0], delivered_at: "yesterday" }] }),
    ).toBe(false);
    expect(isHealth({ status: "healthy" })).toBe(false);
    expect(isHealth({ status: "ok", portal: "latest" })).toBe(false);
    expect(
      isHealth({ status: "ok", reap: { last_run_at: "later", reclaimed: -1 } }),
    ).toBe(false);
    expect(
      isBootstrapResponse({
        status: "AUTHENTICATED",
        csrf_token: "csrf_public",
        expires_in_seconds: 0,
      }),
    ).toBe(false);
    expect(isProblem({ ...problem, status: 200 })).toBe(false);
    expect(isProblem({ ...problem, request_id: "req_deadbeef" })).toBe(false);
  });

  it("rejects missing fields instead of defaulting response truth", () => {
    const { body: _body, ...eventWithoutBody } = event;
    expect(isEventEnvelope(eventWithoutBody)).toBe(false);
    expect(isOutboxView({})).toBe(false);
    const { repair: _repair, ...problemWithoutRepair } = problem;
    expect(isProblem(problemWithoutRepair)).toBe(false);
  });
});

describe("local response semantics outside the generated roots", () => {
  it("accepts one complete demo receipt and refuses missing or mistyped truth", () => {
    expect(isDemoReceipt(demoReceipt)).toBe(true);
    expect(isDemoReceipt({ ...demoReceipt, stale_refused: "true" })).toBe(false);
    expect(isDemoReceipt({ ...demoReceipt, fence_second: 1.5 })).toBe(false);
    const { candidate_head: _candidateHead, ...missingCandidate } = demoReceipt;
    expect(isDemoReceipt(missingCandidate)).toBe(false);
    expect(isRfc3339(null)).toBe(false);
  });
});
