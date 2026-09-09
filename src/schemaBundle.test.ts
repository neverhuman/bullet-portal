import { describe, expect, it } from "vitest";
import {
  CANONICAL_GOLDEN_HASH,
  CANONICAL_GOLDEN_JSON,
  INVARIANT_REGISTRY_HASH,
  POLICY_SNAPSHOT_HASH,
  SCHEMA_BUNDLE_HASH,
  SCHEMA_VERSION,
} from "./generated/schemaBundle";

describe("generated schema bundle identity", () => {
  it("preserves the cross-language canonical bytes", () => {
    expect(CANONICAL_GOLDEN_JSON).toBe(
      '{"a":"é","array":[true,null,17],"z":"last"}',
    );
    expect(JSON.stringify(JSON.parse(CANONICAL_GOLDEN_JSON))).toBe(
      CANONICAL_GOLDEN_JSON,
    );
  });

  it("pins every authority-bearing family input", () => {
    expect(SCHEMA_VERSION).toBe("v1alpha1");
    for (const digest of [
      SCHEMA_BUNDLE_HASH,
      INVARIANT_REGISTRY_HASH,
      POLICY_SNAPSHOT_HASH,
      CANONICAL_GOLDEN_HASH,
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
