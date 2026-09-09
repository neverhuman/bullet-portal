import { describe, expect, it } from "vitest";
import { isHealthy, renderObservation } from "./observation";

describe("observation rendering", () => {
  it("never paints unknown as healthy", () => {
    const obs = { kind: "unknown" as const, text: "read failed" };
    expect(isHealthy(obs)).toBe(false);
    expect(renderObservation(obs)).toMatch(/^unknown/);
    expect(renderObservation(obs)).not.toMatch(/healthy|pass|empty/i);
  });

  it("keeps contradictory distinct", () => {
    const obs = { kind: "contradictory" as const, text: "tmux vs ledger" };
    expect(isHealthy(obs)).toBe(false);
    expect(renderObservation(obs)).toMatch(/^contradictory/);
  });

  it("keeps an empty observation distinct from health", () => {
    const obs = { kind: "empty" as const, text: "no rows" };
    expect(renderObservation(obs)).toBe("empty");
    expect(isHealthy(obs)).toBe(false);
  });

  it("retains a value observation text and health meaning", () => {
    const obs = { kind: "value" as const, text: "verified measurement" };
    expect(renderObservation(obs)).toBe("verified measurement");
    expect(isHealthy(obs)).toBe(true);
  });

});
