import type { DataClass, ProjectIntake } from "./contracts.js";

const dataClasses = new Set<DataClass>(["public", "internal", "possible-pii", "regulated"]);

function finiteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

export function validateIntake(value: unknown): ProjectIntake {
  if (!value || typeof value !== "object") throw new Error("intake must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.useCase !== "string" || input.useCase.trim().length < 12 || input.useCase.length > 2000) {
    throw new Error("useCase must contain 12 to 2000 characters");
  }
  if (typeof input.industry !== "string" || input.industry.trim().length < 2 || input.industry.length > 120) {
    throw new Error("industry must contain 2 to 120 characters");
  }
  if (!Array.isArray(input.dataClasses) || input.dataClasses.length === 0 || !input.dataClasses.every((item) => dataClasses.has(item as DataClass))) {
    throw new Error("dataClasses must contain supported classifications");
  }
  finiteNonNegative(input.monthlyRequests, "monthlyRequests");
  finiteNonNegative(input.averageInputTokens, "averageInputTokens");
  finiteNonNegative(input.averageOutputTokens, "averageOutputTokens");
  const controls = input.controls as Record<string, unknown> | undefined;
  const requiredControls = ["humanApproval", "piiScanning", "auditLogging", "tenantIsolation", "managedSecrets"] as const;
  if (!controls || requiredControls.some((key) => typeof controls[key] !== "boolean")) {
    throw new Error("all controls must be explicit booleans");
  }
  return input as unknown as ProjectIntake;
}
