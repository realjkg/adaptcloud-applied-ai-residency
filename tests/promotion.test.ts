import { describe, expect, it } from "vitest";
import evidenceFixture from "../examples/promotion-evidence.simulated.json" with { type: "json" };
import {
  evaluatePromotion,
  promotionEnvironments,
  promotionGates,
  requiredGatesFor,
  type PromotionEvidence,
  type PromotionGate
} from "../src/platform/promotion.js";

const evidence = evidenceFixture as PromotionEvidence;

describe("environment promotion evaluation", () => {
  it("guides students through the ordered five-stage journey", () => {
    expect(promotionEnvironments).toEqual(["development", "sandbox", "qa", "staging", "production"]);
    const results = promotionEnvironments.map((environment) => evaluatePromotion(environment, evidence, new Date("2026-01-01T00:00:00.000Z")));
    expect(results.every((result) => result.readyForHumanReview)).toBe(true);
    expect(results.every((result) => result.artifact.digest === evidence.artifactDigest)).toBe(true);
    expect(results.every((result) => result.deploymentAuthorized === false)).toBe(true);
  });

  it("uses cumulative gates instead of allowing stages to bypass earlier evidence", () => {
    expect(requiredGatesFor("sandbox")).toContain("unit-tests");
    expect(requiredGatesFor("qa")).toContain("terraform-plan");
    expect(requiredGatesFor("staging")).toContain("adversarial-tests");
    expect(requiredGatesFor("production")).toContain("rollback-drill");
  });

  it("keeps the simulated evidence complete so a new gate cannot be forgotten", () => {
    const gateNames = Object.keys(promotionGates) as PromotionGate[];
    expect(Object.keys(evidence.gates).sort()).toEqual([...gateNames].sort());
    expect(gateNames.every((gate) => evidence.references[gate] !== undefined)).toBe(true);
  });

  it("requires connector review from sandbox onward, where egress could first be enabled", () => {
    expect(promotionGates["connector-review"]).toEqual({ stage: "sandbox", pillar: "security" });
    expect(requiredGatesFor("development")).not.toContain("connector-review");
    for (const environment of ["sandbox", "qa", "staging", "production"] as const) {
      expect(requiredGatesFor(environment)).toContain("connector-review");
    }
  });

  it("blocks sandbox and every later review when connector review is absent", () => {
    const incomplete: PromotionEvidence = {
      ...evidence,
      gates: { ...evidence.gates, "connector-review": false }
    };
    expect(evaluatePromotion("development", incomplete).readyForHumanReview).toBe(true);
    for (const environment of ["sandbox", "qa", "staging", "production"] as const) {
      const result = evaluatePromotion(environment, incomplete);
      expect(result.readyForHumanReview).toBe(false);
      expect(result.missingGates).toEqual(["connector-review"]);
      expect(result.findingsByPillar.security).toContain("connector-review");
    }
  });

  it("blocks QA and every later review when a QA control is absent", () => {
    const incomplete: PromotionEvidence = {
      ...evidence,
      gates: { ...evidence.gates, "adversarial-tests": false }
    };
    expect(evaluatePromotion("sandbox", incomplete).readyForHumanReview).toBe(true);
    for (const environment of ["qa", "staging", "production"] as const) {
      const result = evaluatePromotion(environment, incomplete);
      expect(result.readyForHumanReview).toBe(false);
      expect(result.findingsByPillar.security).toContain("adversarial-tests");
    }
  });

  it("rejects mutable or malformed artifact identities", () => {
    expect(() => evaluatePromotion("qa", { ...evidence, artifactDigest: "latest" })).toThrow(/sha256/);
    expect(() => evaluatePromotion("qa", { ...evidence, commitSha: "main" })).toThrow(/commitSha/);
  });
});
