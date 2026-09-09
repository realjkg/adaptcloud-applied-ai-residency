import type { ControlProfile, DataClass, ProjectIntake } from "./contracts.js";
import { estimateMonthlyCost, pricingFromEnvironment } from "./cost.js";
import { assessControls } from "./governance.js";
import { assessRuntimeReadiness, runtimeConfigFromEnvironment } from "../platform/runtime.js";
import {
  evaluatePromotion,
  promotionEnvironments,
  promotionGates,
  type PromotionEnvironment,
  type PromotionEvidence,
  type PromotionGate
} from "../platform/promotion.js";

/**
 * Bounded read-only tool registry (trust boundaries 2, 3, and 4).
 *
 * The model may retrieve deterministic results; it may not supply pricing, runtime
 * configuration, or authorization. Every tool is pure over its validated input plus
 * operator-supplied environment configuration: no filesystem, network, process, or
 * environment mutation exists in this module, so a write-capable tool cannot be added
 * here without changing the module's imports — which CLAUDE.md rule 3 gates on review.
 */

/** One tool call per tool: every tool is pure, so repeating a call cannot yield new facts. */
export const maxToolCallsPerExchange = 4;

/** Guards against a large deterministic result becoming an unbounded context cost. */
export const maxToolResultBytes = 8_192;

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export type ToolContent = Readonly<Record<string, unknown>>;

export interface ReadOnlyTool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: true;
  readonly inputSchema: ToolInputSchema;
  /** Pure: validated input in, computed facts out. Throws only on invalid input. */
  readonly execute: (input: unknown) => ToolContent;
}

export type ToolResult =
  | { ok: true; content: ToolContent }
  | { ok: false; reason: string };

class ToolInputError extends Error {}

function refuse(reason: string): never {
  throw new ToolInputError(reason);
}

/** Rejects unknown or extra fields rather than ignoring them (CLAUDE.md rule 4). */
function objectWithKeys(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${where} must be an object`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) refuse(`${where} contains unsupported field`);
  }
  return input;
}

function requiredNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12) {
    refuse(`${key} must be a finite number between 0 and 1e12`);
  }
  return value;
}

function requiredBoolean(input: Record<string, unknown>, key: string, where: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") refuse(`${where}.${key} must be a boolean`);
  return value;
}

function requiredString(input: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = input[key];
  if (typeof value !== "string" || value.length > 256 || !pattern.test(value)) {
    refuse(`${key} must match the expected format`);
  }
  return value;
}

const dataClassValues = ["public", "internal", "possible-pii", "regulated"] as const;
const controlKeys = ["humanApproval", "piiScanning", "auditLogging", "tenantIsolation", "managedSecrets"] as const;
const gateNames = Object.keys(promotionGates) as PromotionGate[];

function readDataClasses(value: unknown): DataClass[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > dataClassValues.length) {
    refuse("dataClasses must be a non-empty array of supported classifications");
  }
  const seen: DataClass[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(dataClassValues as readonly string[]).includes(item)) {
      refuse("dataClasses must be a non-empty array of supported classifications");
    }
    seen.push(item as DataClass);
  }
  return seen;
}

function readControls(value: unknown): ControlProfile {
  const input = objectWithKeys(value, controlKeys, "controls");
  return {
    humanApproval: requiredBoolean(input, "humanApproval", "controls"),
    piiScanning: requiredBoolean(input, "piiScanning", "controls"),
    auditLogging: requiredBoolean(input, "auditLogging", "controls"),
    tenantIsolation: requiredBoolean(input, "tenantIsolation", "controls"),
    managedSecrets: requiredBoolean(input, "managedSecrets", "controls")
  };
}

const volumeKeys = ["monthlyRequests", "averageInputTokens", "averageOutputTokens"] as const;

const estimateTokenCost: ReadOnlyTool = {
  name: "estimate_token_cost",
  description:
    "Compute the deterministic monthly token cost for a request volume using operator-supplied pricing only. Prices come from the environment and cannot be supplied by the caller.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      monthlyRequests: { type: "number", minimum: 0, description: "Requests per month." },
      averageInputTokens: { type: "number", minimum: 0, description: "Average input tokens per request." },
      averageOutputTokens: { type: "number", minimum: 0, description: "Average output tokens per request." }
    },
    required: [...volumeKeys],
    additionalProperties: false
  },
  execute: (raw) => {
    const input = objectWithKeys(raw, volumeKeys, "input");
    // estimateMonthlyCost reads only the three volume fields; the narrative intake fields are
    // deliberately not accepted here so no client narrative crosses the tool boundary.
    const intake: ProjectIntake = {
      useCase: "",
      industry: "",
      dataClasses: ["internal"],
      monthlyRequests: requiredNumber(input, "monthlyRequests"),
      averageInputTokens: requiredNumber(input, "averageInputTokens"),
      averageOutputTokens: requiredNumber(input, "averageOutputTokens"),
      controls: { humanApproval: false, piiScanning: false, auditLogging: false, tenantIsolation: false, managedSecrets: false }
    };
    return { cost: estimateMonthlyCost(intake, pricingFromEnvironment()) };
  }
};

const controlKeysTop = ["dataClasses", "controls"] as const;

const assessControlsTool: ReadOnlyTool = {
  name: "assess_controls",
  description:
    "Evaluate the deterministic control findings (AC-001..AC-005) for a declared data classification and control profile.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      dataClasses: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: [...dataClassValues] },
        description: "Declared data classifications."
      },
      controls: {
        type: "object",
        properties: Object.fromEntries(controlKeys.map((key) => [key, { type: "boolean" }])),
        required: [...controlKeys],
        additionalProperties: false,
        description: "Explicit boolean control profile."
      }
    },
    required: [...controlKeysTop],
    additionalProperties: false
  },
  execute: (raw) => {
    const input = objectWithKeys(raw, controlKeysTop, "input");
    const intake: ProjectIntake = {
      useCase: "",
      industry: "",
      dataClasses: readDataClasses(input.dataClasses),
      monthlyRequests: 0,
      averageInputTokens: 0,
      averageOutputTokens: 0,
      controls: readControls(input.controls)
    };
    return { findings: assessControls(intake) };
  }
};

const checkRuntimeReadiness: ReadOnlyTool = {
  name: "check_runtime_readiness",
  description:
    "Return the well-architected readiness findings for the operator-configured runtime. Takes no arguments: the configuration is read from the environment so it cannot be asserted by the caller.",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  execute: (raw) => {
    objectWithKeys(raw ?? {}, [], "input");
    const findings = assessRuntimeReadiness(runtimeConfigFromEnvironment());
    return {
      findings,
      blockerCount: findings.filter((finding) => finding.severity === "blocker").length
    };
  }
};

const promotionKeys = ["targetEnvironment", "evidenceMode", "commitSha", "artifactDigest", "gates", "evaluatedAt"] as const;

function readGates(value: unknown): Record<PromotionGate, boolean> {
  const input = objectWithKeys(value, gateNames, "gates");
  const gates = {} as Record<PromotionGate, boolean>;
  for (const gate of gateNames) {
    const supplied = input[gate];
    if (supplied !== undefined && typeof supplied !== "boolean") refuse(`gates.${gate} must be a boolean`);
    gates[gate] = supplied === true;
  }
  return gates;
}

const checkPromotionGates: ReadOnlyTool = {
  name: "check_promotion_gates",
  description:
    "Evaluate cumulative promotion evidence against the gate matrix for a target environment. Returns required and missing gates; it never authorizes a deployment.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      targetEnvironment: { type: "string", enum: [...promotionEnvironments] },
      evidenceMode: { type: "string", enum: ["simulation", "observed"] },
      commitSha: { type: "string", description: "Lowercase hexadecimal Git commit identifier." },
      artifactDigest: { type: "string", description: "sha256:<64 lowercase hex characters>." },
      gates: {
        type: "object",
        properties: Object.fromEntries(gateNames.map((gate) => [gate, { type: "boolean" }])),
        additionalProperties: false,
        description: "Gate name to satisfied flag. Omitted gates count as unsatisfied."
      },
      evaluatedAt: { type: "string", description: "Optional ISO-8601 evaluation timestamp." }
    },
    required: ["targetEnvironment", "evidenceMode", "commitSha", "artifactDigest", "gates"],
    additionalProperties: false
  },
  execute: (raw) => {
    const input = objectWithKeys(raw, promotionKeys, "input");
    const target = requiredString(input, "targetEnvironment", /^[a-z]+$/) as PromotionEnvironment;
    if (!(promotionEnvironments as readonly string[]).includes(target)) refuse("targetEnvironment is not a supported environment");
    const evidenceMode = requiredString(input, "evidenceMode", /^(simulation|observed)$/) as PromotionEvidence["evidenceMode"];
    // References are intentionally not accepted: they are free text and would carry narrative.
    const evidence: PromotionEvidence = {
      schemaVersion: "1.0",
      evidenceMode,
      commitSha: requiredString(input, "commitSha", /^[0-9a-f]{7,64}$/),
      artifactDigest: requiredString(input, "artifactDigest", /^sha256:[0-9a-f]{64}$/),
      gates: readGates(input.gates),
      references: {}
    };
    if (input.evaluatedAt === undefined) return { evaluation: evaluatePromotion(target, evidence) };
    const stamp = requiredString(input, "evaluatedAt", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    const evaluatedAt = new Date(stamp);
    if (Number.isNaN(evaluatedAt.getTime())) refuse("evaluatedAt must be an ISO-8601 timestamp");
    return { evaluation: evaluatePromotion(target, evidence, evaluatedAt) };
  }
};

export const readOnlyTools: readonly ReadOnlyTool[] = [
  estimateTokenCost,
  assessControlsTool,
  checkRuntimeReadiness,
  checkPromotionGates
];

const registry = new Map<string, ReadOnlyTool>(readOnlyTools.map((tool) => [tool.name, tool]));

export function toolDefinitions(): ToolDefinition[] {
  return readOnlyTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

/**
 * Default-deny dispatch. Every failure — unknown name, invalid input, oversized result, or an
 * exception from the underlying deterministic code — degrades to a returned refusal so a
 * malformed model request cannot fail the request. Refusal reasons never echo caller input.
 */
export function executeTool(name: string, rawInput: unknown): ToolResult {
  if (typeof name !== "string") return { ok: false, reason: "unknown_tool" };
  const tool = registry.get(name);
  if (!tool) return { ok: false, reason: "unknown_tool" };
  let content: ToolContent;
  try {
    content = tool.execute(rawInput);
  } catch (error) {
    if (error instanceof ToolInputError) return { ok: false, reason: `invalid_input: ${error.message}` };
    return { ok: false, reason: "tool_unavailable" };
  }
  if (JSON.stringify(content).length > maxToolResultBytes) return { ok: false, reason: "result_too_large" };
  return { ok: true, content };
}

export interface ToolSession {
  call: (name: string, rawInput: unknown) => ToolResult;
  readonly used: () => number;
}

/**
 * Per-exchange budget. An unbounded tool loop is a cost and availability incident, so the
 * cap is enforced by the caller-held counter rather than by trusting the model to stop.
 */
export function createToolSession(limit: number = maxToolCallsPerExchange): ToolSession {
  let used = 0;
  return {
    call: (name, rawInput) => {
      if (used >= limit) return { ok: false, reason: "tool_call_limit_reached" };
      used += 1;
      return executeTool(name, rawInput);
    },
    used: () => used
  };
}
