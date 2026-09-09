import type { ControlFinding } from "../agent/contracts.js";
import {
  assertSafeInteger,
  criticalFinding,
  requireBoolean,
  requireFiniteNonNegative,
  requireSafeInteger,
  requireString,
  requireStringArray,
  type ScenarioModule,
  type ScenarioPolicyResult
} from "./contracts.js";

export interface CommercialLabInput {
  scenario: "commercial";
  humanApproval: boolean;
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

export const commercialFindingIds = ["COM-APPROVAL", "COM-ACTION"] as const;
export type CommercialFindingId = (typeof commercialFindingIds)[number];

// The lab drafts work; every one of these verbs would reach a system of record or a supplier.
const prohibitedActions = ["submit-work-order", "schedule-labor", "purchase-material", "contact-vendor"];

function parseCommercial(record: Record<string, unknown>): CommercialLabInput {
  return {
    scenario: "commercial",
    humanApproval: requireBoolean(record, "humanApproval"),
    assetId: requireString(record, "assetId"),
    maintenanceObservations: requireStringArray(record, "maintenanceObservations"),
    downtimeHours: requireFiniteNonNegative(record, "downtimeHours"),
    hourlyDowntimeCostMinor: requireSafeInteger(record, "hourlyDowntimeCostMinor"),
    laborHours: requireFiniteNonNegative(record, "laborHours"),
    laborRateMinor: requireSafeInteger(record, "laborRateMinor"),
    materialCostMinor: requireSafeInteger(record, "materialCostMinor"),
    currency: requireString(record, "currency"),
    requestedActions: requireStringArray(record, "requestedActions")
  };
}

function commercialPolicy(input: CommercialLabInput): ScenarioPolicyResult {
  assertSafeInteger(input.hourlyDowntimeCostMinor, "hourlyDowntimeCostMinor");
  assertSafeInteger(input.laborRateMinor, "laborRateMinor");
  assertSafeInteger(input.materialCostMinor, "materialCostMinor");
  if (!Number.isFinite(input.downtimeHours) || input.downtimeHours < 0) throw new Error("downtimeHours must be non-negative");
  if (!Number.isFinite(input.laborHours) || input.laborHours < 0) throw new Error("laborHours must be non-negative");
  const prohibited = input.requestedActions.filter((action) => prohibitedActions.includes(action));
  const findings: ControlFinding[] = [];
  if (!input.humanApproval) findings.push(criticalFinding("COM-APPROVAL", "A human must approve consequential commercial work.", "Require an accountable approver."));
  if (prohibited.length > 0) findings.push(criticalFinding("COM-ACTION", "The lab may draft but cannot execute work, purchasing, scheduling, or vendor actions.", "Remove prohibited actions and retain a draft-only output."));
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

export const commercialModule: ScenarioModule<"commercial", CommercialLabInput> = {
  name: "commercial",
  parse: parseCommercial,
  policy: commercialPolicy,
  findingIds: commercialFindingIds,
  envelope: {
    availabilityTarget: "99.5%",
    recoveryTimeObjective: "4 hours",
    recoveryPointObjective: "24 hours",
    failurePosture: "Queue drafts; never schedule or purchase automatically",
    costUnit: "cost per reviewed opportunity",
    retentionPosture: "Short-lived operational evidence; customer-approved schedule"
  }
};
