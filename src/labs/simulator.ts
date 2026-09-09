import type { ControlFinding, ProjectIntake } from "../agent/contracts.js";
import { runAssessment } from "../agent/workflow.js";
import { commercialModule, type CommercialFindingId, type CommercialLabInput } from "../scenarios/commercial.js";
import { insuranceModule, type InsuranceFindingId, type InsuranceLabInput } from "../scenarios/insurance.js";
import { paymentsModule, type PaymentsFindingId, type PaymentsLabInput } from "../scenarios/payments.js";

export type { CommercialLabInput } from "../scenarios/commercial.js";
export type { InsuranceLabInput } from "../scenarios/insurance.js";
export type { PaymentEvent, PaymentsLabInput } from "../scenarios/payments.js";

export type CloudTarget = "aws" | "gcp";
export type LabScenario = "commercial" | "payments" | "insurance";

export type LabInput = CommercialLabInput | PaymentsLabInput | InsuranceLabInput;

export type ScenarioFindingId = CommercialFindingId | PaymentsFindingId | InsuranceFindingId;

export interface LabSimulationResult {
  schemaVersion: "1.0";
  scenario: LabScenario;
  cloud: CloudTarget;
  status: "ready_for_human_review" | "blocked";
  humanApprovalRequired: true;
  findings: ControlFinding[];
  domain: Record<string, unknown>;
  architecture: Awaited<ReturnType<typeof runAssessment>>;
  evidence: {
    generatedAt: string;
    terraformRoot: string;
    promptLogged: false;
    sensitiveContentLogged: false;
  };
}

// tests/scenario-evals.test.ts reads the refusal ids out of this file's source text, so a new
// refusal cannot ship without an evaluation case. The roster is therefore spelled out as
// literals here rather than computed: the union type makes a typo a compile error, and
// tests/scenario-modules.test.ts fails if it ever drifts from what the modules declare.
const finding = (id: ScenarioFindingId): ScenarioFindingId => id;

export const policyFindingIds: readonly ScenarioFindingId[] = [
  finding("COM-APPROVAL"),
  finding("COM-ACTION"),
  finding("PAY-CURRENCY"),
  finding("PAY-IDEMPOTENCY"),
  finding("PAY-LEDGER"),
  finding("PAY-APPROVAL"),
  finding("INS-EVIDENCE"),
  finding("INS-PROVENANCE"),
  finding("INS-APPROVAL")
];

function architectureIntake(input: LabInput): ProjectIntake {
  const industries = { commercial: "industrial services", payments: "financial services", insurance: "insurance" } as const;
  return {
    useCase: `Run the synthetic ${input.scenario} evidence and human-review lab`,
    industry: industries[input.scenario],
    dataClasses: input.scenario === "commercial" ? ["internal"] : ["regulated"],
    monthlyRequests: 1_000,
    averageInputTokens: 1_200,
    averageOutputTokens: 500,
    controls: {
      humanApproval: input.humanApproval,
      piiScanning: true,
      auditLogging: true,
      tenantIsolation: true,
      managedSecrets: true
    }
  };
}

export async function runLabSimulation(input: LabInput, cloud: CloudTarget, now = new Date()): Promise<LabSimulationResult> {
  const evaluated = input.scenario === "commercial"
    ? commercialModule.policy(input)
    : input.scenario === "payments"
      ? paymentsModule.policy(input)
      : insuranceModule.policy(input);
  const architecture = await runAssessment(architectureIntake(input), now);
  const findings = [...evaluated.findings, ...architecture.findings];
  return {
    schemaVersion: "1.0",
    scenario: input.scenario,
    cloud,
    status: findings.some((item) => item.severity === "critical") ? "blocked" : "ready_for_human_review",
    humanApprovalRequired: true,
    findings,
    domain: evaluated.domain,
    architecture,
    evidence: {
      generatedAt: now.toISOString(),
      terraformRoot: `infra/${cloud}`,
      promptLogged: false,
      sensitiveContentLogged: false
    }
  };
}
