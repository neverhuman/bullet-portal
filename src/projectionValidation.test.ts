import { describe, expect, it } from "vitest";
import {
  auditTailIsCoherent,
  isAuditView,
  isContextLineageView,
  isFleetView,
  isMergeRailView,
  isQualityLabView,
  isSessionSupervisorView,
} from "./apiValidation";

function id(prefix: string, digit: string): string {
  return `${prefix}_${digit.repeat(64)}`;
}

const AT = "2026-08-25T00:00:00.000Z";

const contextCapsule = {
  schema_version: "bullet.context-capsule.initial.v1",
  id: id("ctx", "0"),
  mission_id: id("mis", "1"),
  work_package_id: id("wpk", "2"),
  plan_revision_id: id("pln", "3"),
  revision: 1,
  parent_id: null,
  task_class: "security_analysis",
  objective_digest: "4".repeat(64),
  package_title_digest: "5".repeat(64),
  content_digest: "6".repeat(64),
  compression: "none",
  dropped_decision_digests: [],
  recorded_at: AT,
};

const contextLineage = { capsules: [contextCapsule] };

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
  it("accepts exact populated views for all six direct projection routes", () => {
    expect(isContextLineageView(contextLineage)).toBe(true);
    expect(isFleetView(fleet)).toBe(true);
    expect(isSessionSupervisorView(sessions)).toBe(true);
    expect(isMergeRailView(rail)).toBe(true);
    expect(isQualityLabView(lab)).toBe(true);
    expect(isAuditView(audit)).toBe(true);
  });

  it("accepts empty views: zero rows is a value, not a failure", () => {
    expect(isContextLineageView({ capsules: [] })).toBe(true);
    expect(isFleetView({ authority_time: AT, leases: [], ready_queue: [] })).toBe(true);
    expect(isSessionSupervisorView({ attempts: [], state_counts: [] })).toBe(true);
    expect(
      isMergeRailView({ candidates: [], effects: [], intents: [], receipts: [], intent_state_counts: [] }),
    ).toBe(true);
    expect(isQualityLabView({ evidence: [], outcome_counts: [] })).toBe(true);
    expect(isAuditView({ latest_sequence: 0, tail_window: 64, events: [] })).toBe(true);
  });

  it("rejects unknown keys at every root and nested boundary", () => {
    expect(isContextLineageView({ ...contextLineage, healthy: true })).toBe(false);
    expect(
      isContextLineageView({
        capsules: [{ ...contextCapsule, raw_objective: "not admitted" }],
      }),
    ).toBe(false);
    expect(isFleetView({ ...fleet, healthy: true })).toBe(false);
    expect(isFleetView({ ...fleet, leases: [{ ...lease, healthy: true }] })).toBe(false);
    expect(isSessionSupervisorView({ ...sessions, attempts: [{ ...attempt, ok: 1 }] })).toBe(false);
    expect(isMergeRailView({ ...rail, intents: [{ ...intent, merged: true }] })).toBe(false);
    expect(isQualityLabView({ ...lab, evidence: [{ ...evidence, passed: true }] })).toBe(false);
    expect(isAuditView({ ...audit, events: [{ ...event(1), extra: 1 }], latest_sequence: 1 })).toBe(false);
  });

  it("rejects missing fields rather than defaulting them", () => {
    const { content_digest: _contentDigest, ...capsuleWithoutDigest } = contextCapsule;
    expect(isContextLineageView({ capsules: [capsuleWithoutDigest] })).toBe(false);
    const { liveness: _liveness, ...leaseWithoutLiveness } = lease;
    expect(isFleetView({ ...fleet, leases: [leaseWithoutLiveness] })).toBe(false);
    const { satisfies_requirement: _satisfies, ...evidenceWithoutVerdict } = evidence;
    expect(isQualityLabView({ ...lab, evidence: [evidenceWithoutVerdict] })).toBe(false);
  });

  it("rejects legacy-width or wrong-prefix subjects everywhere", () => {
    expect(
      isContextLineageView({
        capsules: [{ ...contextCapsule, id: id("ctx", "A") }],
      }),
    ).toBe(false);
    expect(
      isContextLineageView({
        capsules: [{ ...contextCapsule, work_package_id: id("mis", "2") }],
      }),
    ).toBe(false);
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
    expect(
      isContextLineageView({ capsules: [{ ...contextCapsule, task_class: "unknown" }] }),
    ).toBe(false);
    expect(
      isContextLineageView({ capsules: [{ ...contextCapsule, task_class: "" }] }),
    ).toBe(false);
    expect(
      isContextLineageView({ capsules: [{ ...contextCapsule, compression: "zstd" }] }),
    ).toBe(false);
    expect(
      isContextLineageView({
        capsules: [{ ...contextCapsule, parent_id: id("ctx", "9") }],
      }),
    ).toBe(false);
    expect(
      isContextLineageView({
        capsules: [{ ...contextCapsule, dropped_decision_digests: ["a".repeat(64)] }],
      }),
    ).toBe(false);
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
    const nonPassingOutcomes = [
      "FAIL",
      "FLAKY",
      "INFRA_ERROR",
      "CANCELLED",
      "TIMED_OUT",
      "NOT_RUN",
      "UNSUPPORTED",
      "UNKNOWN",
      "SUPERSEDED",
      "INVALIDATED",
    ] as const;
    for (const outcome of nonPassingOutcomes) {
      expect(
        isQualityLabView({
          ...lab,
          evidence: [{ ...evidence, outcome, satisfies_requirement: true }],
        }),
        outcome,
      ).toBe(false);
    }
    expect(
      isQualityLabView({
        ...lab,
        evidence: [{ ...evidence, outcome: "PASS", satisfies_requirement: false }],
      }),
    ).toBe(false);
    expect(
      isQualityLabView({
        ...lab,
        evidence: [{ ...evidence, outcome: "PASS", satisfies_requirement: true }],
      }),
    ).toBe(true);
  });

  it("accepts all and only the 16 generated TaskClass values", () => {
    const taskClasses = [
      "deterministic_transform",
      "extract_structured",
      "classify_route",
      "summarize_local",
      "compress_context",
      "mechanical_code_edit",
      "bounded_bug_fix",
      "feature_implementation",
      "broad_refactor",
      "architecture_design",
      "security_analysis",
      "migration_design",
      "code_review",
      "fusion_rank",
      "fusion_synthesize",
      "completion_assessment",
    ];
    expect(taskClasses).toHaveLength(16);
    for (const taskClass of taskClasses) {
      expect(
        isContextLineageView({ capsules: [{ ...contextCapsule, task_class: taskClass }] }),
      ).toBe(true);
    }
    for (const taskClass of ["", "unknown", "SecurityAnalysis", null, 16]) {
      expect(
        isContextLineageView({ capsules: [{ ...contextCapsule, task_class: taskClass }] }),
      ).toBe(false);
    }
  });

  it("rejects malformed Context Lineage timestamps through the generated AJV root", () => {
    for (const recordedAt of ["", "2026-02-30T00:00:00Z", "2026-08-25", 0, null]) {
      expect(
        isContextLineageView({ capsules: [{ ...contextCapsule, recorded_at: recordedAt }] }),
      ).toBe(false);
    }
  });

  it("rejects numeric values outside the authority envelope", () => {
    expect(
      isContextLineageView({ capsules: [{ ...contextCapsule, revision: 2 }] }),
    ).toBe(false);
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
