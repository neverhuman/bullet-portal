import { describe, expect, it } from "vitest";
import { isMission, isMissionList, isMissionView, isReadyView } from "./apiValidation";

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
});
