import type { ControlFinding, CostEstimate } from "../agent/contracts.js";
import type {
  CloudTarget,
  CommercialLabInput,
  InsuranceLabInput,
  PaymentEvent,
  PaymentsLabInput
} from "../labs/simulator.js";

export type ScenarioName = "commercial" | "payments" | "insurance";

export type CommercialScenarioRequest = CommercialLabInput;
export type PaymentsScenarioRequest = PaymentsLabInput;
export type InsuranceScenarioRequest = InsuranceLabInput;

export type ScenarioRequest = CommercialScenarioRequest | PaymentsScenarioRequest | InsuranceScenarioRequest;

export type ScenarioRequestFor<TScenario extends ScenarioName> = Extract<ScenarioRequest, { scenario: TScenario }>;

export type ScenarioStatus = "ready_for_human_review" | "blocked";
export type ScenarioMode = "deterministic" | "claude-assisted";

export interface ScenarioEnvelope {
  schemaVersion: "1.0";
  scenario: ScenarioName;
  cloud: CloudTarget;
  mode: ScenarioMode;
  status: ScenarioStatus;
  humanApprovalRequired: true;
  findings: ControlFinding[];
  cost: CostEstimate;
  domain: Record<string, unknown>;
  recommendation: string;
  evidence: {
    generatedAt: string;
    terraformRoot: string;
    model?: string;
    promptLogged: false;
    sensitiveContentLogged: false;
  };
}

// Bounds keep an untrusted payload from turning into unbounded deterministic work.
const maxStringLength = 2_000;
const maxArrayLength = 200;

const paymentEventTypes = new Set<PaymentEvent["type"]>(["authorization", "capture", "settlement", "reversal", "refund"]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxStringLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxStringLength} characters`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new Error(`${field} must be an explicit boolean`);
  return value;
}

function requireFiniteNonNegative(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function requireSafeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireArray(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length > maxArrayLength) {
    throw new Error(`${field} must be an array of at most ${maxArrayLength} items`);
  }
  return value;
}

function requireStringArray(record: Record<string, unknown>, field: string): string[] {
  return requireArray(record, field).map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > maxStringLength) {
      throw new Error(`${field}[${index}] must be a non-empty string of at most ${maxStringLength} characters`);
    }
    return item;
  });
}

function parseCommercial(record: Record<string, unknown>): CommercialScenarioRequest {
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

function parsePaymentEvent(value: unknown, index: number): PaymentEvent {
  const event = asRecord(value, `events[${index}]`);
  const type = event.type;
  if (typeof type !== "string" || !paymentEventTypes.has(type as PaymentEvent["type"])) {
    throw new Error(`events[${index}].type must be a supported payment event type`);
  }
  return {
    type: type as PaymentEvent["type"],
    amountMinor: requireSafeInteger(event, "amountMinor"),
    currency: requireString(event, "currency"),
    idempotencyKey: requireString(event, "idempotencyKey"),
    sourceId: requireString(event, "sourceId")
  };
}

function parsePayments(record: Record<string, unknown>): PaymentsScenarioRequest {
  const events = requireArray(record, "events");
  if (events.length === 0) throw new Error("events must contain at least one payment event");
  return {
    scenario: "payments",
    humanApproval: requireBoolean(record, "humanApproval"),
    transactionId: requireString(record, "transactionId"),
    currency: requireString(record, "currency"),
    events: events.map(parsePaymentEvent)
  };
}

function parseInsurance(record: Record<string, unknown>): InsuranceScenarioRequest {
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

export function parseScenarioRequest(scenario: ScenarioName, value: unknown): ScenarioRequest {
  const record = asRecord(value, "scenario request");
  const declared = record.scenario;
  if (typeof declared !== "string") throw new Error("scenario request must declare a scenario");
  if (declared !== scenario) {
    // The declared value is untrusted and this message reaches an HTTP response body, so it is
    // echoed only when it is already one of the known names.
    const safe = declared === "commercial" || declared === "payments" || declared === "insurance" ? `"${declared}"` : "an unsupported scenario";
    throw new Error(`scenario mismatch: payload declares ${safe} but the "${scenario}" scenario was requested`);
  }
  if (scenario === "commercial") return parseCommercial(record);
  if (scenario === "payments") return parsePayments(record);
  return parseInsurance(record);
}
