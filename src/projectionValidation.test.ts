import { describe, expect, it } from "vitest";
import {
  auditTailIsCoherent,
  isAuditView,
  isFleetView,
  isMergeRailView,
  isQualityLabView,
  isSessionSupervisorView,
} from "./apiValidation";

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

const AT = "2026-08-25T00:00:00.000Z";

const lease = {
  variant_id: id("var", "1"),
  attempt_id: id("atm", "2"),
  fence: 1,
  runner_id: id("run", "3"),
  runner_epoch: 1,
  heartbeat_at: AT,
  expires_at: "2026-08-25T00:00:15.000Z",
  ttl_seconds: 15,
  liveness: "live",
  attempt_state: "starting",
  work_package_id: id("wpk", "4"),
  mission_id: id("mis", "5"),
};

const fleet = {
  authority_time: AT,
  leases: [lease],
  ready_queue: [{ work_package_id: id("wpk", "4"), enqueued_at: AT }],
};

const attempt = {
  id: id("atm", "2"),
  variant_id: id("var", "1"),
  work_package_id: id("wpk", "4"),
  mission_id: id("mis", "5"),
  fence: 1,
  runner_id: id("run", "3"),
  runner_epoch: 1,
  workspace_id: id("wsp", "6"),
  scope_revision: 1,
  context_revision: 1,
  state: "starting",
  lease: "held",
  leased_at: AT,
  last_lease_event: { seq: 2, at: AT, kind: "attempt_leased" },
};

const sessions = { attempts: [attempt], state_counts: [{ label: "starting", count: 1 }] };

const candidate = {
  id: id("can", "7"),
  attempt_id: id("atm", "2"),
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  tree_sha: "c".repeat(40),
  patch_digest: "d".repeat(64),
};

const intent = {
  id: id("efi", "8"),
  logical_effect_key: "push:x",
  provider: "local-bare",
  target_identity: "refs/heads/x",
  desired_state_hash: "b".repeat(40),
  expected_old_oid: "0".repeat(40),
  attempt_id: id("atm", "2"),
  fence: 1,
  policy_version: "policy-v1",
  payload_hash: "e".repeat(64),
  provider_idempotency_key: null,
  state: "OUTCOME_UNKNOWN",
  unknown_retries: 0,
  created_at: AT,
};

const receipt = {
  id: id("efr", "9"),
  effect_intent_id: id("efi", "8"),
  observed_remote_identity: "refs/heads/x",
  observed_state_hash: null,
  verification_method: "read-back",
  verification_result: "ABSENT",
  adopted_after_unknown: false,
  recorded_at: AT,
};

const effect = {
  id: id("efi", "a"),
  attempt_id: id("atm", "2"),
  logical_key: "scm:push:x",
  desired: "candidate-ref-exists",
  outcome: "unknown",
};

const rail = {
  candidates: [candidate],
  effects: [effect],
  intents: [intent],
  receipts: [receipt],
  intent_state_counts: [{ label: "OUTCOME_UNKNOWN", count: 1 }],
};

const evidence = {
  id: id("evd", "b"),
  candidate_id: id("can", "7"),
  tier: "E2",
  gate: "tests",
  result: "FLAKY",
  outcome: "FLAKY",
  satisfies_requirement: false,
};

const lab = { evidence: [evidence], outcome_counts: [{ label: "FLAKY", count: 1 }] };

function event(seq: number) {
  return {
    id: "f".repeat(64),
    seq,
    at: AT,
    kind: "fixture",
    body: String(seq),
    stream_id: null,
    correlation_id: null,
  };
}

const audit = { latest_sequence: 3, tail_window: 64, events: [event(1), event(2), event(3)] };

describe("generated projection validators", () => {
  it("accepts exact populated views for all five surfaces", () => {
    expect(isFleetView(fleet)).toBe(true);
    expect(isSessionSupervisorView(sessions)).toBe(true);
    expect(isMergeRailView(rail)).toBe(true);
    expect(isQualityLabView(lab)).toBe(true);
    expect(isAuditView(audit)).toBe(true);
  });

  it("accepts empty views: zero rows is a value, not a failure", () => {
    expect(isFleetView({ authority_time: AT, leases: [], ready_queue: [] })).toBe(true);
    expect(isSessionSupervisorView({ attempts: [], state_counts: [] })).toBe(true);
    expect(
      isMergeRailView({ candidates: [], effects: [], intents: [], receipts: [], intent_state_counts: [] }),
    ).toBe(true);
    expect(isQualityLabView({ evidence: [], outcome_counts: [] })).toBe(true);
    expect(isAuditView({ latest_sequence: 0, tail_window: 64, events: [] })).toBe(true);
  });

  it("rejects unknown keys at every root and nested boundary", () => {
    expect(isFleetView({ ...fleet, healthy: true })).toBe(false);
    expect(isFleetView({ ...fleet, leases: [{ ...lease, healthy: true }] })).toBe(false);
    expect(isSessionSupervisorView({ ...sessions, attempts: [{ ...attempt, ok: 1 }] })).toBe(false);
    expect(isMergeRailView({ ...rail, intents: [{ ...intent, merged: true }] })).toBe(false);
    expect(isQualityLabView({ ...lab, evidence: [{ ...evidence, passed: true }] })).toBe(false);
    expect(isAuditView({ ...audit, events: [{ ...event(1), extra: 1 }], latest_sequence: 1 })).toBe(false);
  });

  it("rejects missing fields rather than defaulting them", () => {
    const { liveness: _liveness, ...leaseWithoutLiveness } = lease;
    expect(isFleetView({ ...fleet, leases: [leaseWithoutLiveness] })).toBe(false);
    const { satisfies_requirement: _satisfies, ...evidenceWithoutVerdict } = evidence;
    expect(isQualityLabView({ ...lab, evidence: [evidenceWithoutVerdict] })).toBe(false);
  });

  it("rejects legacy-width or wrong-prefix subjects everywhere", () => {
    expect(isFleetView({ ...fleet, leases: [{ ...lease, attempt_id: `atm_${"2".repeat(32)}` }] })).toBe(false);
    expect(isFleetView({ ...fleet, leases: [{ ...lease, runner_id: id("wsp", "3") }] })).toBe(false);
    expect(
      isSessionSupervisorView({ ...sessions, attempts: [{ ...attempt, workspace_id: id("run", "6") }] }),
    ).toBe(false);
    expect(isMergeRailView({ ...rail, candidates: [{ ...candidate, patch_digest: "D".repeat(64) }] })).toBe(
      false,
    );
    expect(isMergeRailView({ ...rail, receipts: [{ ...receipt, id: id("rcp", "9") }] })).toBe(false);
    expect(isQualityLabView({ ...lab, evidence: [{ ...evidence, id: id("evd", "B") }] })).toBe(false);
    expect(isAuditView({ ...audit, events: [{ ...event(1), id: "short" }], latest_sequence: 1 })).toBe(
      false,
    );
  });

  it("rejects labels outside the frozen catalogs so nothing reads as green by accident", () => {
    expect(isFleetView({ ...fleet, leases: [{ ...lease, liveness: "green" }] })).toBe(false);
    expect(isSessionSupervisorView({ ...sessions, attempts: [{ ...attempt, state: "done" }] })).toBe(false);
    expect(isSessionSupervisorView({ ...sessions, attempts: [{ ...attempt, lease: "maybe" }] })).toBe(false);
    expect(
      isSessionSupervisorView({
        ...sessions,
        attempts: [{ ...attempt, last_lease_event: { seq: 2, at: AT, kind: "lease_renewed" } }],
      }),
    ).toBe(false);
    expect(isMergeRailView({ ...rail, intents: [{ ...intent, state: "MERGED" }] })).toBe(false);
    expect(isMergeRailView({ ...rail, receipts: [{ ...receipt, verification_result: "OK" }] })).toBe(false);
    expect(isQualityLabView({ ...lab, evidence: [{ ...evidence, outcome: "passed" }] })).toBe(false);
  });

  it("rejects numeric values outside the authority envelope", () => {
    expect(isFleetView({ ...fleet, leases: [{ ...lease, ttl_seconds: 16 }] })).toBe(false);
    expect(isFleetView({ ...fleet, leases: [{ ...lease, fence: -1 }] })).toBe(false);
    expect(isSessionSupervisorView({ ...sessions, state_counts: [{ label: "starting", count: -1 }] })).toBe(
      false,
    );
    expect(isAuditView({ ...audit, tail_window: 0, events: [] , latest_sequence: 0 })).toBe(false);
  });

  it("treats an audit tail that contradicts its watermark as invalid", () => {
    expect(auditTailIsCoherent({ latest_sequence: 4, tail_window: 64, events: audit.events })).toBe(false);
    expect(
      auditTailIsCoherent({ latest_sequence: 3, tail_window: 64, events: [event(1), event(3)] }),
    ).toBe(false);
    expect(auditTailIsCoherent({ latest_sequence: 5, tail_window: 64, events: [] })).toBe(false);
    expect(auditTailIsCoherent({ latest_sequence: 2, tail_window: 1, events: [event(1), event(2)] })).toBe(
      false,
    );
    expect(isAuditView({ ...audit, latest_sequence: 4 })).toBe(false);
  });
});
