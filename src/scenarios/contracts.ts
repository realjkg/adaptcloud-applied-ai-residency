import type { ControlFinding, CostEstimate } from "../agent/contracts.js";
import type { CloudTarget } from "../labs/simulator.js";
import { commercialModule, type CommercialLabInput } from "./commercial.js";
import { insuranceModule, type InsuranceLabInput } from "./insurance.js";
import { paymentsModule, type PaymentsLabInput } from "./payments.js";

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

export interface ScenarioPolicyResult {
  findings: ControlFinding[];
  domain: Record<string, unknown>;
}

/** Starting service-level assumptions from the overlay table in docs/WELL_ARCHITECTED.md. */
export interface ScenarioOperatingEnvelope {
  availabilityTarget: string;
  recoveryTimeObjective: string;
  recoveryPointObjective: string;
  failurePosture: string;
  costUnit: string;
  retentionPosture: string;
}

/** One scenario's whole surface: its parser, its deterministic policy, and what it may refuse. */
export interface ScenarioModule<TName extends ScenarioName, TRequest> {
  readonly name: TName;
  readonly parse: (record: Record<string, unknown>) => TRequest;
  readonly policy: (input: TRequest) => ScenarioPolicyResult;
  readonly findingIds: readonly string[];
  readonly envelope: ScenarioOperatingEnvelope;
}

// Bounds keep an untrusted payload from turning into unbounded deterministic work.
const maxStringLength = 2_000;
const maxArrayLength = 200;

export const criticalFinding = (id: string, message: string, remediation: string): ControlFinding => ({
  id,
  severity: "critical",
  message,
  remediation
});

export function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxStringLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxStringLength} characters`);
  }
  return value;
}

export function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new Error(`${field} must be an explicit boolean`);
  return value;
}

export function requireFiniteNonNegative(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

export function requireSafeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function requireArray(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length > maxArrayLength) {
    throw new Error(`${field} must be an array of at most ${maxArrayLength} items`);
  }
  return value;
}

export function requireStringArray(record: Record<string, unknown>, field: string): string[] {
  return requireArray(record, field).map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > maxStringLength) {
      throw new Error(`${field}[${index}] must be a non-empty string of at most ${maxStringLength} characters`);
    }
    return item;
  });
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
  // Resolved inside the call so the module imports stay a cycle-safe lazy reference.
  if (scenario === "commercial") return commercialModule.parse(record);
  if (scenario === "payments") return paymentsModule.parse(record);
  return insuranceModule.parse(record);
}
