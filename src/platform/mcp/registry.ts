import type { RuntimeConfig } from "../runtime.js";
import type {
  McpCallRequest,
  McpCallResult,
  McpConnectorDescriptor,
  McpLayerConfig,
  McpRuntimeRefusalReason,
  McpUntrustedData
} from "./contracts.js";
import { evaluateConnectorCall } from "./policy.js";
import { deniedResolver, type CredentialRequest, type CredentialResolver } from "./credentials.js";
import type { McpTransport, McpTransportResult } from "./transport.js";

/**
 * The single call path for MCP connectors.
 *
 * Order is the control: policy decides first and is never re-run, a credential is minted only
 * after policy allows, the transport is called under a timeout and a bounded retry, and the body
 * is size-checked before it is handed back wrapped as untrusted data. Nothing the connector
 * returns is inspected for meaning here — a result cannot grant an approval, enable an operation,
 * or change a finding, because the decision that authorized it was already made and discarded.
 * Every failure is a returned refusal so the caller falls back to deterministic behaviour.
 */

export interface McpCallContext {
  readonly config: McpLayerConfig;
  readonly runtime: RuntimeConfig;
  readonly transport: McpTransport;
  readonly resolver?: CredentialResolver;
  readonly now?: () => Date;
}

function fail(reason: McpRuntimeRefusalReason): McpCallResult {
  return { ok: false, reason };
}

/** Registration is startup configuration: a duplicate identifier is a config error, not a call error. */
export function createConnectorRegistry(
  descriptors: readonly McpConnectorDescriptor[]
): ReadonlyMap<string, McpConnectorDescriptor> {
  const registry = new Map<string, McpConnectorDescriptor>();
  for (const descriptor of descriptors) {
    if (registry.has(descriptor.id)) throw new Error(`mcp_connector_duplicate_id:${descriptor.id}`);
    const names = new Set<string>();
    for (const operation of descriptor.operations) {
      if (names.has(operation.name)) throw new Error(`mcp_operation_duplicate_name:${descriptor.id}`);
      names.add(operation.name);
    }
    registry.set(descriptor.id, descriptor);
  }
  return registry;
}

async function withTimeout(work: Promise<McpTransportResult>, timeoutMs: number): Promise<McpTransportResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<McpTransportResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "transport_timeout" }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function callConnector(context: McpCallContext, request: McpCallRequest): Promise<McpCallResult> {
  const now = context.now ?? (() => new Date());
  const decision = evaluateConnectorCall(context.config, request, context.runtime, now());
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const allowed = decision.allowed;

  const credentialRequest: CredentialRequest = {
    connectorId: allowed.connectorId,
    provider: allowed.provider,
    operation: allowed.operation,
    audience: allowed.endpointHost,
    scopes: [allowed.operationClass === "read-only" ? "read" : "write"]
  };
  const resolver = context.resolver ?? deniedResolver;
  let resolution;
  try {
    resolution = await resolver.resolve(credentialRequest);
  } catch {
    // The rejection value may carry the credential material, so it is discarded unread.
    return fail("credential_unavailable");
  }
  if (!resolution.ok) return fail("credential_unavailable");

  let last: McpTransportResult = { ok: false, reason: "transport_unavailable" };
  for (let attempt = 1; attempt <= allowed.maxAttempts; attempt += 1) {
    try {
      last = await withTimeout(
        context.transport.invoke({
          connectorId: allowed.connectorId,
          operation: allowed.operation,
          endpointUrl: allowed.endpointUrl,
          input: request.input,
          timeoutMs: allowed.timeoutMs,
          attempt,
          credential: resolution.credential
        }),
        allowed.timeoutMs
      );
    } catch {
      last = { ok: false, reason: "transport_unavailable" };
    }
    if (last.ok) break;
    // A refusal is a decision, not a fault, and a non-idempotent operation is never repeated.
    if (last.reason === "transport_refused" || !allowed.retryPermitted) break;
  }
  if (!last.ok) return fail(last.reason);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(last.body);
  } catch {
    return fail("result_not_serializable");
  }
  if (serialized === undefined) return fail("result_not_serializable");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > allowed.maxResultBytes) return fail("result_too_large");

  const data: McpUntrustedData = {
    untrusted: true,
    connectorId: allowed.connectorId,
    operation: allowed.operation,
    value: JSON.parse(serialized) as unknown
  };
  return { ok: true, connectorId: allowed.connectorId, operation: allowed.operation, data, bytes };
}

export interface McpSession {
  call: (request: McpCallRequest) => Promise<McpCallResult>;
  readonly used: () => number;
}

/**
 * Per-exchange budget held by the caller. An unbounded connector loop is a cost, latency, and
 * partner-abuse incident, so the cap is counted here rather than trusted to the model or the
 * connector. A refused call still consumes nothing: only attempts that reach policy are counted.
 */
export function createMcpSession(context: McpCallContext, limit?: number): McpSession {
  const cap = limit ?? context.config.limits.maxCallsPerExchange;
  let used = 0;
  return {
    call: async (request) => {
      if (used >= cap) return fail("call_limit_reached");
      used += 1;
      return await callConnector(context, request);
    },
    used: () => used
  };
}
