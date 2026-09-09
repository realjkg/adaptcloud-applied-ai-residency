/**
 * Operator configuration for the MCP connector layer.
 *
 * This is the only module that reads the environment for connector settings, and it is where a
 * misconfiguration must become a refusal rather than an accident. Two rules shape it:
 *
 * 1. Anything unparseable disables the layer. A connector that half-reads its allowlist is worse
 *    than one that is off, because the operator believes a control is in place.
 * 2. No variable carries a credential. `MCP_CREDENTIAL_MODE` selects which platform resolver the
 *    host injects; the secret itself never passes through configuration.
 */
import {
  awsConnectorDescriptor,
  awsReadOnlyOperations,
  defaultMcpLimits,
  disabledMcpLayerConfig,
  gcpConnectorDescriptor,
  gcpReadOnlyOperations,
  type McpConnectorBinding,
  type McpConnectorDescriptor,
  type McpLayerConfig,
  type McpLimits
} from "./contracts.js";
import type { CredentialKind } from "./credentials.js";

export type CredentialMode = "denied" | CredentialKind;

export interface McpConfigResult {
  readonly config: McpLayerConfig;
  readonly credentialMode: CredentialMode;
  /** Why the layer is off or narrowed. Empty when the operator asked for nothing unusual. */
  readonly notes: readonly string[];
}

function list(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string, notes: string[]): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    notes.push(`${name} must be an integer between ${min} and ${max}; the connector layer stays disabled`);
    return Number.NaN;
  }
  return parsed;
}

function bindingFor(
  descriptor: McpConnectorDescriptor,
  environment: NodeJS.ProcessEnv,
  prefix: string,
  defaultOperations: readonly string[],
  notes: string[]
): McpConnectorBinding | undefined {
  if (environment[`${prefix}_ENABLED`] !== "true") return undefined;
  const endpointUrl = environment[`${prefix}_ENDPOINT_URL`];
  if (endpointUrl === undefined || endpointUrl.trim() === "") {
    notes.push(`${prefix}_ENABLED is true but ${prefix}_ENDPOINT_URL is unset; the connector is not bound`);
    return undefined;
  }
  const allowedOperations = list(environment[`${prefix}_ALLOWED_OPERATIONS`]);
  const allowedConsequentialOperations = list(environment[`${prefix}_ALLOWED_CONSEQUENTIAL_OPERATIONS`]);
  if (allowedConsequentialOperations.length > 0) {
    // Recorded because opting a mutation in is the decision a reviewer most needs to see. Policy
    // still demands a per-call approval reference, so this note is a signal, not the control.
    notes.push(`${prefix} opts into consequential operations: ${allowedConsequentialOperations.join(", ")}`);
  }
  return {
    descriptor,
    enabled: true,
    endpointUrl,
    allowedOperations: allowedOperations.length > 0 ? allowedOperations : [...defaultOperations],
    allowedConsequentialOperations
  };
}

export function mcpConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): McpConfigResult {
  const notes: string[] = [];
  const credentialModeRaw = environment.MCP_CREDENTIAL_MODE ?? "denied";
  const credentialMode: CredentialMode =
    credentialModeRaw === "workload-identity" || credentialModeRaw === "oidc-exchange" ? credentialModeRaw : "denied";
  if (credentialModeRaw !== credentialMode) {
    notes.push("MCP_CREDENTIAL_MODE is not a supported mode; credentials stay denied");
  }

  if (environment.MCP_CONNECTORS_ENABLED !== "true") {
    return { config: disabledMcpLayerConfig, credentialMode, notes };
  }

  const limits: McpLimits = {
    callTimeoutMs: boundedInteger(environment.MCP_CALL_TIMEOUT_MS, defaultMcpLimits.callTimeoutMs, 1, 30_000, "MCP_CALL_TIMEOUT_MS", notes),
    maxAttempts: boundedInteger(environment.MCP_MAX_ATTEMPTS, defaultMcpLimits.maxAttempts, 1, 3, "MCP_MAX_ATTEMPTS", notes),
    maxCallsPerExchange: boundedInteger(environment.MCP_MAX_CALLS_PER_EXCHANGE, defaultMcpLimits.maxCallsPerExchange, 1, 16, "MCP_MAX_CALLS_PER_EXCHANGE", notes),
    maxResultBytes: boundedInteger(environment.MCP_MAX_RESULT_BYTES, defaultMcpLimits.maxResultBytes, 1, 262_144, "MCP_MAX_RESULT_BYTES", notes)
  };
  if (Object.values(limits).some((limit) => Number.isNaN(limit))) {
    return { config: disabledMcpLayerConfig, credentialMode, notes };
  }

  const allowedHosts = list(environment.MCP_ALLOWED_HOSTS);
  if (allowedHosts.length === 0) {
    notes.push("MCP_ALLOWED_HOSTS is empty; every endpoint is refused by the egress allowlist");
  }

  const connectors = [
    bindingFor(awsConnectorDescriptor, environment, "MCP_AWS", awsReadOnlyOperations, notes),
    bindingFor(gcpConnectorDescriptor, environment, "MCP_GCP", gcpReadOnlyOperations, notes)
  ].filter((binding): binding is McpConnectorBinding => binding !== undefined);

  if (connectors.length === 0) {
    notes.push("no connector is bound; the layer is enabled but has nothing to call");
  }
  if (credentialMode === "denied") {
    notes.push("MCP_CREDENTIAL_MODE is denied; every call is refused after policy with credential_unavailable");
  }

  return { config: { enabled: true, allowedHosts, connectors, limits }, credentialMode, notes };
}
