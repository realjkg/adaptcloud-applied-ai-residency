import type { RuntimeConfig } from "../runtime.js";
import type {
  McpAllowedCall,
  McpCallRequest,
  McpCallResult,
  McpConnectorDescriptor,
  McpLayerConfig,
  McpOperationClass,
  McpRefusalReason,
  McpRuntimeRefusalReason,
  McpUntrustedData
} from "./contracts.js";
import { evaluateConnectorCall } from "./policy.js";
import { deniedResolver, type CredentialRequest, type CredentialResolver } from "./credentials.js";
import type { McpTransport, McpTransportResult } from "./transport.js";
import { auditName, defaultMcpAuditSink, emitMcpAuditEvent, type McpAuditSink } from "./audit.js";

/**
 * The single call path for MCP connectors.
 *
 * Order is the control: policy decides first and is never re-run, a credential is minted only
 * after policy allows, the transport is called under a timeout and a bounded retry, and the body
 * is size-checked before it is handed back wrapped as untrusted data. Nothing the connector
 * returns is inspected for meaning here — a result cannot grant an approval, enable an operation,
 * or change a finding, because the decision that authorized it was already made and discarded.
 * Every failure is a returned refusal so the caller falls back to deterministic behaviour.
 *
 * Every path out of this module — policy refusal, runtime refusal, success — emits exactly one
 * metadata-only audit event. A refusal that leaves no trace is the failure mode that makes an
 * egress control unreviewable, so emission is in the call path rather than left to callers.
 */

export interface McpCallContext {
  readonly config: McpLayerConfig;
  readonly runtime: RuntimeConfig;
  readonly transport: McpTransport;
  readonly resolver?: CredentialResolver;
  readonly now?: () => Date;
  /** Injectable audit sink. Defaults to the repository's structured event writer. */
  readonly audit?: McpAuditSink;
}

function fail(reason: McpRuntimeRefusalReason): McpCallResult {
  return { ok: false, reason };
}

/**
 * In-flight count per call context. The context is the unit an exchange holds, so a session and
 * every call made through it share one bound; two unrelated exchanges do not contend.
 */
const inFlightByContext = new WeakMap<McpCallContext, number>();

function acquireSlot(context: McpCallContext, cap: number): boolean {
  const current = inFlightByContext.get(context) ?? 0;
  if (current >= cap) return false;
  inFlightByContext.set(context, current + 1);
  return true;
}

function releaseSlot(context: McpCallContext): void {
  const current = inFlightByContext.get(context) ?? 1;
  inFlightByContext.set(context, current > 0 ? current - 1 : 0);
}

/** Media type without parameters, lowercased: `application/json; charset=utf-8` is compared as `application/json`. */
function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Wire-level checks on what the transport reports. They live here, above the seam, so the stub
 * exercises them today and a live transport cannot ship without them.
 */
function transportMetadataFailure(
  allowed: McpAllowedCall,
  result: Extract<McpTransportResult, { ok: true }>
): McpRuntimeRefusalReason | undefined {
  if (result.redirectCount !== undefined) {
    if (!Number.isInteger(result.redirectCount) || result.redirectCount < 0) return "redirect_not_permitted";
    // A redirect is how an allowlisted host hands the call to one that was never reviewed.
    if (result.redirectCount > allowed.maxRedirects) return "redirect_not_permitted";
  }
  if (result.contentType !== undefined) {
    const contentType = normalizeContentType(result.contentType);
    if (!allowed.allowedContentTypes.includes(contentType)) return "content_type_not_allowed";
  }
  return undefined;
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
  const startedAt = Date.now();
  const sink = context.audit ?? defaultMcpAuditSink;
  // Names are recorded only if they pass the name check: on an invalid request they came from
  // the caller, not from operator configuration, so they are not free text to be logged.
  let connectorId = auditName(request?.connectorId);
  let operationName = auditName(request?.operation);
  let operationClass: McpOperationClass | "unknown" = "unknown";
  let approvalId: string | undefined;
  let attempts = 0;
  let resultBytes = 0;

  const record = (result: McpCallResult): McpCallResult => {
    emitMcpAuditEvent(sink, {
      type: "mcp.connector.call",
      connectorId,
      operation: operationName,
      operationClass,
      decision: result.ok ? "allowed" : "refused",
      ...(result.ok ? {} : { reason: result.reason satisfies McpRefusalReason }),
      attempts,
      durationMs: Date.now() - startedAt,
      resultBytes,
      ...(approvalId === undefined ? {} : { approvalId })
    });
    return result;
  };

  const now = context.now ?? (() => new Date());
  const decision = evaluateConnectorCall(context.config, request, context.runtime, now());
  if (!decision.ok) return record({ ok: false, reason: decision.reason });
  const allowed = decision.allowed;
  connectorId = allowed.connectorId;
  operationName = allowed.operation;
  operationClass = allowed.operationClass;
  approvalId = allowed.approvalId;

  // The concurrency bound is taken before any credential is minted or any socket would open.
  if (!acquireSlot(context, context.config.limits.maxConcurrentCalls)) {
    return record(fail("concurrency_limit_reached"));
  }
  try {
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
      return record(fail("credential_unavailable"));
    }
    if (!resolution.ok) return record(fail("credential_unavailable"));

    let last: McpTransportResult = { ok: false, reason: "transport_unavailable" };
    for (let attempt = 1; attempt <= allowed.maxAttempts; attempt += 1) {
      attempts = attempt;
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
    if (!last.ok) return record(fail(last.reason));

    const metadataFailure = transportMetadataFailure(allowed, last);
    if (metadataFailure) return record(fail(metadataFailure));

    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(last.body);
    } catch {
      return record(fail("result_not_serializable"));
    }
    if (serialized === undefined) return record(fail("result_not_serializable"));
    const bytes = Buffer.byteLength(serialized, "utf8");
    // Refuse rather than truncate: a half-read body is a fact nobody checked.
    if (bytes > allowed.maxResultBytes) return record(fail("result_too_large"));
    resultBytes = bytes;

    const data: McpUntrustedData = {
      untrusted: true,
      connectorId: allowed.connectorId,
      operation: allowed.operation,
      value: JSON.parse(serialized) as unknown
    };
    return record({ ok: true, connectorId: allowed.connectorId, operation: allowed.operation, data, bytes });
  } finally {
    releaseSlot(context);
  }
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
      if (used >= cap) {
        // Emitted here as well: a budget refusal never reaches the call path, and a refusal that
        // leaves no trace looks exactly like a call that was never attempted.
        emitMcpAuditEvent(context.audit ?? defaultMcpAuditSink, {
          type: "mcp.connector.call",
          connectorId: auditName(request?.connectorId),
          operation: auditName(request?.operation),
          operationClass: "unknown",
          decision: "refused",
          reason: "call_limit_reached",
          attempts: 0,
          durationMs: 0,
          resultBytes: 0
        });
        return fail("call_limit_reached");
      }
      used += 1;
      return await callConnector(context, request);
    },
    used: () => used
  };
}
