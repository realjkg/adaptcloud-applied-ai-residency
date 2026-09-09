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

/** Same shape policy validates: exact `type/subtype`, no wildcard and no parameters. */
const contentTypePattern = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/**
 * Fail-closed media-type list. An unparseable entry returns `undefined`, which disables the whole
 * layer, because an operator who believes JSON is enforced must not silently get "anything".
 */
function contentTypes(value: string | undefined, notes: string[]): readonly string[] | undefined {
  const entries = list(value);
  if (entries.length === 0) return defaultMcpLimits.allowedContentTypes;
  const normalized = entries.map((entry) => entry.toLowerCase());
  if (normalized.length > 8 || normalized.some((entry) => !contentTypePattern.test(entry))) {
    notes.push(
      "MCP_ALLOWED_CONTENT_TYPES must be up to 8 exact media types such as application/json; the connector layer stays disabled"
    );
    return undefined;
  }
  return normalized;
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

  const allowedContentTypes = contentTypes(environment.MCP_ALLOWED_CONTENT_TYPES, notes);
  const limits: McpLimits = {
    callTimeoutMs: boundedInteger(environment.MCP_CALL_TIMEOUT_MS, defaultMcpLimits.callTimeoutMs, 1, 30_000, "MCP_CALL_TIMEOUT_MS", notes),
    maxAttempts: boundedInteger(environment.MCP_MAX_ATTEMPTS, defaultMcpLimits.maxAttempts, 1, 3, "MCP_MAX_ATTEMPTS", notes),
    maxCallsPerExchange: boundedInteger(environment.MCP_MAX_CALLS_PER_EXCHANGE, defaultMcpLimits.maxCallsPerExchange, 1, 16, "MCP_MAX_CALLS_PER_EXCHANGE", notes),
    maxResultBytes: boundedInteger(environment.MCP_MAX_RESULT_BYTES, defaultMcpLimits.maxResultBytes, 1, 262_144, "MCP_MAX_RESULT_BYTES", notes),
    // Zero by default: following a redirect would let an allowlisted host hand the call to one
    // that was never reviewed, so an operator has to ask for it explicitly and narrowly.
    maxRedirects: boundedInteger(environment.MCP_MAX_REDIRECTS, defaultMcpLimits.maxRedirects, 0, 2, "MCP_MAX_REDIRECTS", notes),
    allowedContentTypes: allowedContentTypes ?? defaultMcpLimits.allowedContentTypes,
    maxConcurrentCalls: boundedInteger(environment.MCP_MAX_CONCURRENT_CALLS, defaultMcpLimits.maxConcurrentCalls, 1, 8, "MCP_MAX_CONCURRENT_CALLS", notes)
  };
  if (allowedContentTypes === undefined || Object.values(limits).some((limit) => typeof limit === "number" && Number.isNaN(limit))) {
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
