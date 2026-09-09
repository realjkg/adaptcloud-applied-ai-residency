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
import { deniedResolver, type CredentialRequest, type CredentialResolver, type ShortLivedCredential } from "./credentials.js";
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

/**
 * Media type without parameters, lowercased: `application/json; charset=utf-8` is compared as
 * `application/json`. The argument is typed as a string and checked as `unknown` anyway: the value
 * crosses the transport seam, and the obvious live implementation forwards
 * `response.headers.get("content-type")`, which is `string | null`. A non-string there must be a
 * refusal, never a `TypeError` from `.split` — a throw would break both invariants of this module
 * at once (never throw, exactly one audit event).
 */
function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

const transportFailureReasons: ReadonlySet<string> = new Set([
  "transport_unavailable",
  "transport_timeout",
  "transport_refused"
]);

/**
 * Shape check at the transport seam. A transport is external code — a stub in a lab today, an
 * HTTP client later — so what it returns is validated rather than trusted to match its type.
 * `null`, a missing `ok`, or an unrecognised `reason` becomes `transport_unavailable`, which is
 * how every other unusable answer from a transport is already reported, instead of an exception
 * escaping the call path and leaving no audit event behind.
 */
function asTransportResult(value: unknown): McpTransportResult {
  const unusable: McpTransportResult = { ok: false, reason: "transport_unavailable" };
  if (value === null || typeof value !== "object") return unusable;
  const candidate = value as { readonly ok?: unknown; readonly reason?: unknown };
  if (candidate.ok === true) return value as Extract<McpTransportResult, { ok: true }>;
  if (candidate.ok === false && typeof candidate.reason === "string" && transportFailureReasons.has(candidate.reason)) {
    return value as Extract<McpTransportResult, { ok: false }>;
  }
  return unusable;
}

/** Same reasoning for the credential seam: an off-contract resolution is `credential_unavailable`. */
function hasCredential(value: unknown): value is { readonly ok: true; readonly credential: ShortLivedCredential } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { readonly ok?: unknown; readonly credential?: { readonly reveal?: unknown } };
  return candidate.ok === true && typeof candidate.credential?.reveal === "function";
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
    if (contentType === undefined || !allowed.allowedContentTypes.includes(contentType)) {
      return "content_type_not_allowed";
    }
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

/**
 * Bound one attempt in time and cancel the work when the bound wins.
 *
 * Racing alone only bounds how long *this frame* waits; the transport keeps running, so the
 * request is still in flight after the caller has been told it timed out. The abort controller is
 * what makes the timeout mean something at the socket, and the caller additionally keeps the
 * concurrency slot until `work` settles, so the cap bounds real in-flight work rather than frames.
 */
async function withTimeout(
  work: Promise<McpTransportResult>,
  timeoutMs: number,
  controller: AbortController
): Promise<McpTransportResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<McpTransportResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "transport_timeout" });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ceiling on the wall-clock time one connector call may consume across all of its attempts.
 *
 * `maxAttempts` (up to 3) multiplied by `callTimeoutMs` (up to 30000) is 90 seconds, which
 * outlives the runtime's own `REQUEST_TIMEOUT_MS` ceiling of 60 seconds: the enclosing request
 * would already have been abandoned while this call was still retrying. The deadline is shared
 * across attempts and bounds each attempt to the time that is left, so the configured retry
 * budget can never exceed the request it runs inside.
 */
export const maxTotalCallMs = 30_000;

/** Wall-clock budget for one call across every attempt it is allowed to make. */
export function callBudgetMs(maxAttempts: number, timeoutMs: number): number {
  return Math.min(maxAttempts * timeoutMs, maxTotalCallMs);
}

/**
 * Time the next attempt may take: whatever is left of the shared budget, never more than one
 * configured call timeout. Zero or less means the call is out of budget and no further attempt is
 * started — the retry loop cannot extend a call past the deadline it began with.
 */
export function attemptBudgetMs(elapsedMs: number, maxAttempts: number, timeoutMs: number): number {
  return Math.min(timeoutMs, callBudgetMs(maxAttempts, timeoutMs) - elapsedMs);
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
  let recorded = false;

  // Exactly one event per path, enforced rather than remembered: the flag makes a second call a
  // no-op, so the catch-all below cannot double-record a path that already emitted.
  const record = (result: McpCallResult): McpCallResult => {
    if (recorded) return result;
    recorded = true;
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

  try {
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

    // Work started at the transport seam. The slot is held until every one of these settles, not
    // until this frame returns: a timed-out attempt is still running until the transport honours
    // the abort, and releasing early would let the cap count frames instead of sockets.
    const started: Promise<unknown>[] = [];
    let unsettled = 0;
    try {
      const credentialRequest: CredentialRequest = {
        connectorId: allowed.connectorId,
        provider: allowed.provider,
        operation: allowed.operation,
        audience: allowed.endpointHost,
        scopes: [allowed.operationClass === "read-only" ? "read" : "write"]
      };
      const resolver = context.resolver ?? deniedResolver;
      let resolution: unknown;
      try {
        resolution = await resolver.resolve(credentialRequest);
      } catch {
        // The rejection value may carry the credential material, so it is discarded unread.
        return record(fail("credential_unavailable"));
      }
      // An off-contract resolution is indistinguishable from a refusal, so it cannot be probed.
      if (!hasCredential(resolution)) return record(fail("credential_unavailable"));
      const credential: ShortLivedCredential = resolution.credential;

      // One deadline for the whole call, shared by every attempt.
      let last: McpTransportResult = { ok: false, reason: "transport_unavailable" };
      for (let attempt = 1; attempt <= allowed.maxAttempts; attempt += 1) {
        const remainingMs = attemptBudgetMs(Date.now() - startedAt, allowed.maxAttempts, allowed.timeoutMs);
        if (remainingMs <= 0) {
          // Out of budget before this attempt could start: the call is over, not still retrying.
          if (attempt > 1) last = { ok: false, reason: "transport_timeout" };
          break;
        }
        attempts = attempt;
        const controller = new AbortController();
        try {
          const invocation = Promise.resolve().then(async () =>
            await context.transport.invoke({
              connectorId: allowed.connectorId,
              operation: allowed.operation,
              endpointUrl: allowed.endpointUrl,
              input: request.input,
              timeoutMs: remainingMs,
              attempt,
              credential,
              signal: controller.signal
            })
          );
          unsettled += 1;
          const tracked = invocation.then(
            (value) => {
              unsettled -= 1;
              return value;
            },
            (error: unknown) => {
              unsettled -= 1;
              throw error;
            }
          );
          started.push(tracked.then(() => undefined, () => undefined));
          last = asTransportResult(await withTimeout(tracked, remainingMs, controller));
        } catch {
          controller.abort();
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
      // Recorded before the size decision, not after: `result_too_large` is the one refusal whose
      // reason is the size, so an operator tuning `MCP_MAX_RESULT_BYTES` from audit data must see
      // the measurement that caused it rather than a zero.
      resultBytes = bytes;
      // Refuse rather than truncate: a half-read body is a fact nobody checked.
      if (bytes > allowed.maxResultBytes) return record(fail("result_too_large"));

      const data: McpUntrustedData = {
        untrusted: true,
        connectorId: allowed.connectorId,
        operation: allowed.operation,
        value: JSON.parse(serialized) as unknown
      };
      return record({ ok: true, connectorId: allowed.connectorId, operation: allowed.operation, data, bytes });
    } finally {
      if (unsettled === 0) releaseSlot(context);
      else void Promise.allSettled(started).then(() => releaseSlot(context));
    }
  } catch {
    // Nothing may leave this function by throwing: a caller that must fall back deterministically
    // cannot do so from an exception, and an unrecorded path is an egress call with no audit
    // trail. An unexpected fault is reported the same way an unusable transport answer is.
    return record(fail("transport_unavailable"));
  }
}

export interface McpSession {
  call: (request: McpCallRequest) => Promise<McpCallResult>;
  readonly used: () => number;
}

/**
 * Per-exchange budget held by the caller. An unbounded connector loop is a cost, latency, and
 * partner-abuse incident, so the cap is counted here rather than trusted to the model or the
 * connector. The budget is spent on the attempt, not on the outcome: it is decremented before
 * `callConnector` runs, so a call that policy or the transport refuses consumes one unit of the
 * exchange budget exactly like a successful one. That is deliberate — a caller that retried a
 * refused call for free would have no bound at all, which is the loop this cap exists to stop.
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
