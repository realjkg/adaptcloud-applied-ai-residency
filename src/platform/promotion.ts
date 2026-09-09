import type { WellArchitectedPillar } from "./runtime.js";

export const promotionEnvironments = ["development", "sandbox", "qa", "staging", "production"] as const;
export type PromotionEnvironment = typeof promotionEnvironments[number];
export type EvidenceMode = "simulation" | "observed";

/**
 * The cumulative gate matrix. A gate is earned at one stage and required at that stage and every
 * later one, so a missing early control blocks every later review.
 *
 * `connector-review` sits at sandbox because sandbox is the first stage with a real cloud account,
 * platform credentials, and network egress — the first place the MCP connector layer in
 * `src/platform/mcp/` could be switched on against something real. Development runs locally against
 * the stub transport. The gate is a security finding rather than a cost one: the layer's risk is
 * egress and credential blast radius, and its evidence is the threat model in
 * `docs/adr/0002-mcp-connector-threat-model.md` plus the connector settings actually in force.
 */
export const promotionGates = {
  "requirements-mapped": { stage: "development", pillar: "operational-efficiency" },
  "unit-tests": { stage: "development", pillar: "reliability" },
  "agent-evaluations": { stage: "development", pillar: "reliability" },
  "scenario-matrix": { stage: "development", pillar: "security" },
  "immutable-artifact": { stage: "sandbox", pillar: "security" },
  "container-acceptance": { stage: "sandbox", pillar: "security" },
  "connector-review": { stage: "sandbox", pillar: "security" },
  "terraform-plan": { stage: "sandbox", pillar: "operational-efficiency" },
  "telemetry-integration": { stage: "sandbox", pillar: "reliability" },
  "cleanup-plan": { stage: "sandbox", pillar: "cost-optimization" },
  "cleanup-verified": { stage: "sandbox", pillar: "cost-optimization" },
  "contract-tests": { stage: "qa", pillar: "reliability" },
  "negative-tests": { stage: "qa", pillar: "security" },
  "adversarial-tests": { stage: "qa", pillar: "security" },
  "supply-chain-scan": { stage: "qa", pillar: "security" },
  "load-test": { stage: "staging", pillar: "reliability" },
  "rollback-drill": { stage: "staging", pillar: "resilience" },
  "restore-drill": { stage: "staging", pillar: "resilience" },
  "slo-defined": { stage: "staging", pillar: "reliability" },
  "cost-reviewed": { stage: "staging", pillar: "cost-optimization" },
  "sustainability-reviewed": { stage: "staging", pillar: "sustainability" },
  "threat-model": { stage: "production", pillar: "security" },
  "runbook-exercised": { stage: "production", pillar: "operational-efficiency" },
  "change-approval": { stage: "production", pillar: "operational-efficiency" },
  "production-owner-approval": { stage: "production", pillar: "security" }
} as const satisfies Record<string, { stage: PromotionEnvironment; pillar: WellArchitectedPillar }>;

export type PromotionGate = keyof typeof promotionGates;

export interface PromotionEvidence {
  schemaVersion: "1.0";
  evidenceMode: EvidenceMode;
  commitSha: string;
  artifactDigest: string;
  gates: Record<PromotionGate, boolean>;
  references: Partial<Record<PromotionGate, string>>;
}

export interface PromotionEvaluation {
  schemaVersion: "1.0";
  evidenceMode: EvidenceMode;
  targetEnvironment: PromotionEnvironment;
  evaluatedAt: string;
  artifact: {
    commitSha: string;
    digest: string;
    buildOncePromoteSameArtifact: true;
  };
  requiredGates: PromotionGate[];
  missingGates: PromotionGate[];
  findingsByPillar: Partial<Record<WellArchitectedPillar, PromotionGate[]>>;
  readyForHumanReview: boolean;
  deploymentAuthorized: false;
}

function assertEvidenceIdentity(evidence: PromotionEvidence): void {
  if (!/^[0-9a-f]{7,64}$/.test(evidence.commitSha)) throw new Error("commitSha must be a lowercase hexadecimal Git commit identifier");
  if (!/^sha256:[0-9a-f]{64}$/.test(evidence.artifactDigest)) throw new Error("artifactDigest must be a sha256 digest");
}

export function requiredGatesFor(target: PromotionEnvironment): PromotionGate[] {
  const targetIndex = promotionEnvironments.indexOf(target);
  if (targetIndex < 0) throw new Error("unsupported promotion environment");
  return (Object.entries(promotionGates) as Array<[PromotionGate, (typeof promotionGates)[PromotionGate]]>)
    .filter(([, gate]) => promotionEnvironments.indexOf(gate.stage) <= targetIndex)
    .map(([name]) => name);
}

export function evaluatePromotion(
  target: PromotionEnvironment,
  evidence: PromotionEvidence,
  evaluatedAt = new Date()
): PromotionEvaluation {
  assertEvidenceIdentity(evidence);
  const requiredGates = requiredGatesFor(target);
  const missingGates = requiredGates.filter((gate) => evidence.gates[gate] !== true);
  const findingsByPillar: PromotionEvaluation["findingsByPillar"] = {};
  for (const gate of missingGates) {
    const pillar = promotionGates[gate].pillar;
    findingsByPillar[pillar] = [...(findingsByPillar[pillar] ?? []), gate];
  }
  return {
    schemaVersion: "1.0",
    evidenceMode: evidence.evidenceMode,
    targetEnvironment: target,
    evaluatedAt: evaluatedAt.toISOString(),
    artifact: {
      commitSha: evidence.commitSha,
      digest: evidence.artifactDigest,
      buildOncePromoteSameArtifact: true
    },
    requiredGates,
    missingGates,
    findingsByPillar,
    readyForHumanReview: missingGates.length === 0,
    deploymentAuthorized: false
  };
}
