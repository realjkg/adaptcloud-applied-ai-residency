/**
 * MCP connector contracts (trust boundary 4: the action boundary).
 *
 * A cloud-provider MCP server is an external system that returns data and, in principle, could
 * change the world. This module holds only types and starter descriptors: the deterministic
 * decision lives in `policy.ts`, credential custody in `credentials.ts`, and the single call
 * path in `registry.ts`. Nothing here reads configuration, environment, files, or the network.
 *
 * Two invariants are stated here because callers must be able to read them without reading the
 * implementation:
 *
 * 1. Nothing is enabled by default. A connector call requires an operator allowlist entry that
 *    names the connector, its endpoint host, and each permitted operation. There is no wildcard.
 * 2. Everything an MCP server returns is untrusted input, exactly like client intake. It is
 *    carried in `McpUntrustedData` so a reader cannot mistake it for a control value. It never
 *    becomes an instruction, and it never changes a policy outcome, an approval state, or a
 *    finding severity — the deterministic checks run before the call and are not re-evaluated
 *    afterwards.
 */

export type McpProvider = "aws" | "gcp";

/** Read-only operations observe; consequential operations change something in the provider. */
export type McpOperationClass = "read-only" | "consequential";

export interface McpOperationDescriptor {
  readonly name: string;
  readonly operationClass: McpOperationClass;
  /** Retry is permitted only for an idempotent read; a consequential retry can double an effect. */
  readonly idempotent: boolean;
  readonly description: string;
}

export interface McpConnectorDescriptor {
  readonly id: string;
  readonly provider: McpProvider;
  readonly description: string;
  readonly operations: readonly McpOperationDescriptor[];
}

export interface McpLimits {
  readonly callTimeoutMs: number;
  readonly maxAttempts: number;
  readonly maxCallsPerExchange: number;
  readonly maxResultBytes: number;
  /** A redirect is how an allowlisted host hands a call to one that was never reviewed. */
  readonly maxRedirects: number;
  /** Exact media types, no wildcards and no parameters. An unexpected type is refused, not parsed. */
  readonly allowedContentTypes: readonly string[];
  /** Upper bound on connector calls in flight at once: a bound on blast radius, cost, and latency. */
  readonly maxConcurrentCalls: number;
}

/** Operator allowlist entry. Both operation lists are exact names; `*` is rejected by policy. */
export interface McpConnectorBinding {
  readonly descriptor: McpConnectorDescriptor;
  readonly enabled: boolean;
  readonly endpointUrl: string;
  readonly allowedOperations: readonly string[];
  /** Consequential operations opted into by name. An entry here still requires an approval reference. */
  readonly allowedConsequentialOperations: readonly string[];
}

export interface McpLayerConfig {
  readonly enabled: boolean;
  /** Egress allowlist of hostnames. A host absent here is refused even if a binding names it. */
  readonly allowedHosts: readonly string[];
  readonly connectors: readonly McpConnectorBinding[];
  readonly limits: McpLimits;
}

/** Evidence that a human approved one consequential operation on one connector. */
export interface ApprovalReference {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly connectorId: string;
  readonly operation: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface McpCallRequest {
  readonly connectorId: string;
  readonly operation: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly approval?: ApprovalReference;
}

/** Marker wrapper: a reader that unwraps this has acknowledged the content is untrusted. */
export interface McpUntrustedData {
  readonly untrusted: true;
  readonly connectorId: string;
  readonly operation: string;
  readonly value: unknown;
}

export const policyRefusalReasons = [
  "request_invalid",
  "connector_layer_disabled",
  "production_requires_managed_secrets",
  "production_requires_gateway_auth",
  "unknown_connector",
  "connector_not_enabled",
  "limits_invalid",
  "wildcard_not_permitted",
  "endpoint_url_invalid",
  "endpoint_not_https",
  "endpoint_host_metadata_service",
  "endpoint_host_not_public",
  "endpoint_host_not_allowlisted",
  "unknown_operation",
  "operation_not_allowlisted",
  "consequential_operation_requires_approval",
  "consequential_operation_not_opted_in",
  "approval_reference_invalid",
  "approval_reference_mismatch",
  "approval_reference_expired"
] as const;

export const runtimeRefusalReasons = [
  "call_limit_reached",
  "credential_unavailable",
  "transport_unavailable",
  "transport_timeout",
  "transport_refused",
  "result_too_large",
  "result_not_serializable",
  "concurrency_limit_reached",
  "redirect_not_permitted",
  "content_type_not_allowed"
] as const;

export type McpPolicyRefusalReason = typeof policyRefusalReasons[number];
export type McpRuntimeRefusalReason = typeof runtimeRefusalReasons[number];
export type McpRefusalReason = McpPolicyRefusalReason | McpRuntimeRefusalReason;

export const mcpRefusalReasons: readonly McpRefusalReason[] = [...policyRefusalReasons, ...runtimeRefusalReasons];

/** What policy authorized. `endpointUrl` and `timeoutMs` come from operator config, never from a request. */
export interface McpAllowedCall {
  readonly connectorId: string;
  readonly provider: McpProvider;
  readonly operation: string;
  readonly operationClass: McpOperationClass;
  readonly endpointUrl: string;
  readonly endpointHost: string;
  readonly retryPermitted: boolean;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxResultBytes: number;
  readonly maxRedirects: number;
  readonly allowedContentTypes: readonly string[];
  readonly approvalId?: string;
}

export type McpPolicyDecision =
  | { readonly ok: true; readonly allowed: McpAllowedCall }
  | { readonly ok: false; readonly reason: McpPolicyRefusalReason };

/** Every failure is a returned value: the caller degrades to deterministic behaviour, never a throw. */
export type McpCallResult =
  | { readonly ok: true; readonly connectorId: string; readonly operation: string; readonly data: McpUntrustedData; readonly bytes: number }
  | { readonly ok: false; readonly reason: McpRefusalReason };

export const defaultMcpLimits: McpLimits = {
  callTimeoutMs: 5_000,
  maxAttempts: 2,
  maxCallsPerExchange: 4,
  maxResultBytes: 16_384,
  maxRedirects: 0,
  allowedContentTypes: ["application/json"],
  maxConcurrentCalls: 2
};

/** The configuration the layer has when an operator has configured nothing. */
export const disabledMcpLayerConfig: McpLayerConfig = {
  enabled: false,
  allowedHosts: [],
  connectors: [],
  limits: defaultMcpLimits
};

function operation(
  name: string,
  operationClass: McpOperationClass,
  idempotent: boolean,
  description: string
): McpOperationDescriptor {
  return { name, operationClass, idempotent, description };
}

/**
 * Starter operation sets. Only the read-only operations match this repository's evidence needs
 * (deployment status, cost and budget figures, log and metric summaries). The consequential
 * entries are declared so policy can classify and refuse them by name; they are deliberately
 * absent from every default allowlist and cannot be enabled by a wildcard.
 */
export const awsReadOnlyOperations: readonly string[] = [
  "aws.describe_service_deployment",
  "aws.read_cost_summary",
  "aws.read_budget_status",
  "aws.read_log_summary",
  "aws.read_metric_summary"
];

export const gcpReadOnlyOperations: readonly string[] = [
  "gcp.describe_service_revision",
  "gcp.read_billing_summary",
  "gcp.read_budget_status",
  "gcp.read_log_summary",
  "gcp.read_metric_summary"
];

export const awsConnectorDescriptor: McpConnectorDescriptor = {
  id: "aws-mcp",
  provider: "aws",
  description: "Read-only AWS facts used as promotion and cost evidence.",
  operations: [
    operation("aws.describe_service_deployment", "read-only", true, "Deployment status of one named service."),
    operation("aws.read_cost_summary", "read-only", true, "Cost figure for one account, service, and period."),
    operation("aws.read_budget_status", "read-only", true, "Budget name, limit, and consumed amount."),
    operation("aws.read_log_summary", "read-only", true, "Counts and levels for one log group and window."),
    operation("aws.read_metric_summary", "read-only", true, "Aggregated metric statistics for one window."),
    operation("aws.update_service_deployment", "consequential", false, "Changes a running deployment. Never in a default allowlist."),
    operation("aws.set_budget", "consequential", false, "Changes a budget limit. Never in a default allowlist.")
  ]
};

export const gcpConnectorDescriptor: McpConnectorDescriptor = {
  id: "gcp-mcp",
  provider: "gcp",
  description: "Read-only Google Cloud facts used as promotion and cost evidence.",
  operations: [
    operation("gcp.describe_service_revision", "read-only", true, "Serving status of one service revision."),
    operation("gcp.read_billing_summary", "read-only", true, "Billing figure for one project and period."),
    operation("gcp.read_budget_status", "read-only", true, "Budget name, amount, and consumed amount."),
    operation("gcp.read_log_summary", "read-only", true, "Counts and severities for one log filter and window."),
    operation("gcp.read_metric_summary", "read-only", true, "Aggregated metric statistics for one window."),
    operation("gcp.deploy_service_revision", "consequential", false, "Deploys a revision. Never in a default allowlist."),
    operation("gcp.set_budget", "consequential", false, "Changes a budget amount. Never in a default allowlist.")
  ]
};

export const starterConnectorDescriptors: readonly McpConnectorDescriptor[] = [
  awsConnectorDescriptor,
  gcpConnectorDescriptor
];
