import type { ControlFinding, ProjectIntake } from "../agent/contracts.js";
import { runAssessment } from "../agent/workflow.js";

export type CloudTarget = "aws" | "gcp";
export type LabScenario = "commercial" | "payments" | "insurance";

interface CommonInput {
  scenario: LabScenario;
  humanApproval: boolean;
}

export interface CommercialLabInput extends CommonInput {
  scenario: "commercial";
  assetId: string;
  maintenanceObservations: string[];
  downtimeHours: number;
  hourlyDowntimeCostMinor: number;
  laborHours: number;
  laborRateMinor: number;
  materialCostMinor: number;
  currency: string;
  requestedActions: string[];
}

export interface PaymentEvent {
  type: "authorization" | "capture" | "settlement" | "reversal" | "refund";
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  sourceId: string;
}

export interface PaymentsLabInput extends CommonInput {
  scenario: "payments";
  transactionId: string;
  currency: string;
  events: PaymentEvent[];
}

export interface InsuranceLabInput extends CommonInput {
  scenario: "insurance";
  claimId: string;
  lossType: string;
  narrative: string;
  requiredDocuments: string[];
  documents: Array<{ type: string; sourceId: string }>;
  facts: Array<{ name: string; value: string; sourceId: string }>;
}

export type LabInput = CommercialLabInput | PaymentsLabInput | InsuranceLabInput;

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

const finding = (id: string, message: string, remediation: string): ControlFinding => ({
  id,
  severity: "critical",
  message,
  remediation
});

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function commercialPolicy(input: CommercialLabInput): { findings: ControlFinding[]; domain: Record<string, unknown> } {
  assertSafeInteger(input.hourlyDowntimeCostMinor, "hourlyDowntimeCostMinor");
  assertSafeInteger(input.laborRateMinor, "laborRateMinor");
  assertSafeInteger(input.materialCostMinor, "materialCostMinor");
  if (!Number.isFinite(input.downtimeHours) || input.downtimeHours < 0) throw new Error("downtimeHours must be non-negative");
  if (!Number.isFinite(input.laborHours) || input.laborHours < 0) throw new Error("laborHours must be non-negative");
  const prohibited = input.requestedActions.filter((action) => ["submit-work-order", "schedule-labor", "purchase-material", "contact-vendor"].includes(action));
  const findings: ControlFinding[] = [];
  if (!input.humanApproval) findings.push(finding("COM-APPROVAL", "A human must approve consequential commercial work.", "Require an accountable approver."));
  if (prohibited.length > 0) findings.push(finding("COM-ACTION", "The lab may draft but cannot execute work, purchasing, scheduling, or vendor actions.", "Remove prohibited actions and retain a draft-only output."));
  const laborCostMinor = Math.round(input.laborHours * input.laborRateMinor);
  const estimatedDowntimeEffectMinor = Math.round(input.downtimeHours * input.hourlyDowntimeCostMinor);
  return {
    findings,
    domain: {
      assetId: input.assetId,
      observationCount: input.maintenanceObservations.length,
      currency: input.currency,
      assumptions: ["labor hours and rates are estimates", "downtime effect is not a promised saving"],
      estimatedLaborCostMinor: laborCostMinor,
      estimatedMaterialCostMinor: input.materialCostMinor,
      estimatedDowntimeEffectMinor,
      workOrderDrafted: true,
      externalActionTaken: false
    }
  };
}

function paymentsPolicy(input: PaymentsLabInput): { findings: ControlFinding[]; domain: Record<string, unknown> } {
  const findings: ControlFinding[] = [];
  const keys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const event of input.events) {
    assertSafeInteger(event.amountMinor, "event amountMinor");
    if (!event.currency || event.currency !== input.currency) findings.push(finding("PAY-CURRENCY", "Every payment event must use the transaction currency.", "Correct or quarantine the contradictory event."));
    if (keys.has(event.idempotencyKey)) duplicateKeys.add(event.idempotencyKey);
    keys.add(event.idempotencyKey);
  }
  if (duplicateKeys.size > 0) findings.push(finding("PAY-IDEMPOTENCY", "Duplicate idempotency keys block reconciliation.", "Investigate duplicates without moving funds."));
  const total = (type: PaymentEvent["type"]): number => input.events.filter((event) => event.type === type).reduce((sum, event) => sum + event.amountMinor, 0);
  const captured = total("capture");
  const settled = total("settlement");
  const reversed = total("reversal");
  const refunded = total("refund");
  if (captured !== settled + reversed || refunded > settled) findings.push(finding("PAY-LEDGER", "Synthetic capture, settlement, reversal, and refund evidence does not reconcile.", "Escalate the exception for operator review; do not move funds."));
  if (!input.humanApproval) findings.push(finding("PAY-APPROVAL", "A payment exception requires operator approval.", "Assign an authorized human reviewer."));
  return {
    findings,
    domain: {
      transactionId: input.transactionId,
      currency: input.currency,
      eventCount: input.events.length,
      timelineSourceIds: input.events.map((event) => event.sourceId),
      capturedMinor: captured,
      settledMinor: settled,
      reversedMinor: reversed,
      refundedMinor: refunded,
      fundsMoved: false,
      fraudDecisionMade: false
    }
  };
}

function insurancePolicy(input: InsuranceLabInput): { findings: ControlFinding[]; domain: Record<string, unknown> } {
  const findings: ControlFinding[] = [];
  const sourceIds = new Set(input.documents.map((document) => document.sourceId));
  const missingDocuments = input.requiredDocuments.filter((required) => !input.documents.some((document) => document.type === required));
  const unsupportedFacts = input.facts.filter((fact) => !sourceIds.has(fact.sourceId)).map((fact) => fact.name);
  if (missingDocuments.length > 0) findings.push(finding("INS-EVIDENCE", "Required synthetic evidence is missing.", "Keep the gap open and request the named documents."));
  if (unsupportedFacts.length > 0) findings.push(finding("INS-PROVENANCE", "Every material fact must reference a supplied source identifier.", "Remove or source unsupported facts."));
  if (!input.humanApproval) findings.push(finding("INS-APPROVAL", "Claim routing requires human adjuster review.", "Assign an authorized human adjuster."));
  return {
    findings,
    domain: {
      claimId: input.claimId,
      lossType: input.lossType,
      evidenceSourceIds: [...sourceIds],
      supportedFactNames: input.facts.filter((fact) => sourceIds.has(fact.sourceId)).map((fact) => fact.name),
      missingDocuments,
      unsupportedFacts,
      narrativeLogged: false,
      coverageDetermined: false,
      liabilityDetermined: false,
      paymentAuthorized: false
    }
  };
}

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
    ? commercialPolicy(input)
    : input.scenario === "payments"
      ? paymentsPolicy(input)
      : insurancePolicy(input);
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
