import type { ControlFinding } from "../agent/contracts.js";
import {
  asRecord,
  criticalFinding,
  requireArray,
  requireBoolean,
  requireString,
  requireStringArray,
  type ScenarioModule,
  type ScenarioPolicyResult
} from "./contracts.js";

export interface InsuranceLabInput {
  scenario: "insurance";
  humanApproval: boolean;
  claimId: string;
  lossType: string;
  narrative: string;
  requiredDocuments: string[];
  documents: Array<{ type: string; sourceId: string }>;
  facts: Array<{ name: string; value: string; sourceId: string }>;
}

export const insuranceFindingIds = ["INS-EVIDENCE", "INS-PROVENANCE", "INS-APPROVAL"] as const;
export type InsuranceFindingId = (typeof insuranceFindingIds)[number];

function parseInsurance(record: Record<string, unknown>): InsuranceLabInput {
  const documents = requireArray(record, "documents").map((value, index) => {
    const document = asRecord(value, `documents[${index}]`);
    return { type: requireString(document, "type"), sourceId: requireString(document, "sourceId") };
  });
  const facts = requireArray(record, "facts").map((value, index) => {
    const fact = asRecord(value, `facts[${index}]`);
    return { name: requireString(fact, "name"), value: requireString(fact, "value"), sourceId: requireString(fact, "sourceId") };
  });
  return {
    scenario: "insurance",
    humanApproval: requireBoolean(record, "humanApproval"),
    claimId: requireString(record, "claimId"),
    lossType: requireString(record, "lossType"),
    narrative: requireString(record, "narrative"),
    requiredDocuments: requireStringArray(record, "requiredDocuments"),
    documents,
    facts
  };
}

function insurancePolicy(input: InsuranceLabInput): ScenarioPolicyResult {
  const findings: ControlFinding[] = [];
  const sourceIds = new Set(input.documents.map((document) => document.sourceId));
  const missingDocuments = input.requiredDocuments.filter((required) => !input.documents.some((document) => document.type === required));
  const unsupportedFacts = input.facts.filter((fact) => !sourceIds.has(fact.sourceId)).map((fact) => fact.name);
  if (missingDocuments.length > 0) findings.push(criticalFinding("INS-EVIDENCE", "Required synthetic evidence is missing.", "Keep the gap open and request the named documents."));
  if (unsupportedFacts.length > 0) findings.push(criticalFinding("INS-PROVENANCE", "Every material fact must reference a supplied source identifier.", "Remove or source unsupported facts."));
  if (!input.humanApproval) findings.push(criticalFinding("INS-APPROVAL", "Claim routing requires human adjuster review.", "Assign an authorized human adjuster."));
  return {
    findings,
    domain: {
      claimId: input.claimId,
      lossType: input.lossType,
      evidenceSourceIds: [...sourceIds],
      supportedFactNames: input.facts.filter((fact) => sourceIds.has(fact.sourceId)).map((fact) => fact.name),
      missingDocuments,
      unsupportedFacts,
      // The narrative stays in the request; it is never copied into evidence or logs.
      narrativeLogged: false,
      coverageDetermined: false,
      liabilityDetermined: false,
      paymentAuthorized: false
    }
  };
}

export const insuranceModule: ScenarioModule<"insurance", InsuranceLabInput> = {
  name: "insurance",
  parse: parseInsurance,
  policy: insurancePolicy,
  findingIds: insuranceFindingIds,
  envelope: {
    availabilityTarget: "99.5%",
    recoveryTimeObjective: "4 hours",
    recoveryPointObjective: "1 hour",
    failurePosture: "Preserve provenance and missing evidence; human adjudication only",
    costUnit: "cost per reviewed intake",
    retentionPosture: "Policy- and jurisdiction-approved schedule; narratives excluded from logs"
  }
};
