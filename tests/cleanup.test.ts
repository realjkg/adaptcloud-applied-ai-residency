import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import evidenceFixture from "../examples/promotion-evidence.simulated.json" with { type: "json" };
import { evaluatePromotion, type PromotionEvidence } from "../src/platform/promotion.js";

const read = (path: string): string => readFileSync(path, "utf8");

describe("student sandbox cleanup", () => {
  it("requires a destroy plan, exact confirmation, empty state, and residual inventory", () => {
    const workflow = read(".github/workflows/infrastructure.yml");
    const guard = read("scripts/guard-infrastructure.mjs");
    expect(workflow).toContain("terraform -chdir=infra/aws plan");
    expect(workflow).toContain("terraform -chdir=infra/gcp plan");
    expect(workflow).toContain("terraform -chdir=infra/aws state list");
    expect(workflow).toContain("terraform -chdir=infra/gcp state list");
    expect(workflow).toContain("bash scripts/verify-sandbox-cleanup.sh");
    expect(guard).toContain("DESTROY MY SANDBOX");
  });

  it("scopes residual discovery to the authenticated account or project and repository labels", () => {
    const verifier = read("scripts/verify-sandbox-cleanup.sh");
    expect(verifier).toContain('actual_scope=$(aws sts get-caller-identity');
    expect(verifier).toContain('actual_scope=$(gcloud projects describe "$expected_scope"');
    expect(verifier).toContain("Key=Environment,Values=sandbox");
    expect(verifier).toContain("Key=ManagedBy,Values=terraform");
    expect(verifier).toContain("labels.environment:sandbox");
    expect(verifier).not.toMatch(/aws-nuke|--no-dry-run|gcloud projects delete/);
  });

  it("blocks promotion when sandbox cleanup has not been proven", () => {
    const evidence = evidenceFixture as PromotionEvidence;
    const incomplete: PromotionEvidence = {
      ...evidence,
      gates: { ...evidence.gates, "cleanup-verified": false }
    };
    const result = evaluatePromotion("qa", incomplete);
    expect(result.readyForHumanReview).toBe(false);
    expect(result.findingsByPillar["cost-optimization"]).toContain("cleanup-verified");
  });
});
