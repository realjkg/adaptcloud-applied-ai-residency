import type { RuntimeConfig } from "../runtime.js";
import type {
  ApprovalReference,
  McpAllowedCall,
  McpCallRequest,
  McpConnectorBinding,
  McpLayerConfig,
  McpOperationDescriptor,
  McpPolicyDecision,
  McpPolicyRefusalReason
} from "./contracts.js";

/**
 * The deterministic decision engine for the MCP connector layer (CLAUDE.md rule 5).
 *
 * Pure over its arguments: no filesystem, network, process, or environment access exists in this
 * module, so the decision can be exhaustively tested and cannot be influenced by anything a model
 * or an MCP server says. Refusals are machine-readable reasons and never echo request content.
 * Order matters and is asserted by tests: the layer switch, then environment gating, then the
 * connector, then egress, then the operation, then approval. SSRF checks run before the host
 * allowlist so a mistaken allowlist entry cannot re-open a blocked address.
 */

function refuse(reason: McpPolicyRefusalReason): McpPolicyDecision {
  return { ok: false, reason };
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function hasWildcard(entries: readonly string[]): boolean {
  return entries.some((entry) => entry.includes("*"));
}

/**
 * Canonical form of a host for every check in this module and for the operator allowlist.
 *
 * The WHATWG parser preserves a trailing root dot in a name (`localhost.`, `metadata.google.internal.`)
 * and that dotted form resolves to exactly the same address as the undotted one. Left in place it
 * defeats every name-based rule here at once: the metadata set misses, each suffix rule misses, and
 * the bare-label rule misses because the host now "contains a dot". Canonicalising here — before any
 * check and before the allowlist comparison — is what keeps the documented invariant true, that the
 * allowlist can only narrow the permitted set and never re-open a blocked address. Repeated trailing
 * dots are stripped too: `localhost..` is not a resolvable distinct name, only a distinct string.
 * A port never appears in `URL.hostname`, so no port stripping is needed for an endpoint; allowlist
 * entries are shape-checked at parse time in `config.ts`.
 */
export function canonicalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

const metadataHosts = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "169.254.169.123",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "fd00:ec2::254",
  "instance-data"
]);

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for anything that is not a routable public name: an SSRF target or an internal service. */
function isNonPublicHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  // A bare label has no public delegation, so it can only resolve inside the deployment network.
  if (!host.includes(".") && !host.includes(":")) return true;
  const ipv4 = ipv4Pattern.exec(host);
  if (ipv4) {
    const octets = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map((part) => Number(part ?? "256"));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a = 256, b = 256] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    // Any other literal address bypasses name-based review, so it is refused as well.
    return true;
  }
  if (host.includes(":")) return true; // IPv6 literal: loopback, unique-local, link-local, or unreviewed.
  return false;
}

/**
 * Strict ISO-8601 instant with an explicit offset. `Date.parse` accepts far more than this — a
 * zone-less `2025-12-31T00:00` is read as *local* time and an RFC-2822-ish `Dec 31, 2025` parses
 * as well, either of which moves an approval window by up to 14 hours depending on where the
 * process runs. An approval window is an authorization boundary, so it is validated as a format
 * before it is parsed as a time.
 */
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Longest window a single approval may describe. Twenty-four hours: an approval is evidence that a
 * named human decided one operation on one connector, and beyond a day nobody is still watching the
 * thing they approved — a longer window is a standing grant wearing an approval's clothes. It also
 * bounds the damage of a leaked reference to a single operational day. An operator who needs the
 * same operation tomorrow issues a new approval, which is the review the cap exists to force.
 */
export const maxApprovalWindowMs = 24 * 60 * 60 * 1000;

function approvalFailure(
  approval: ApprovalReference,
  request: McpCallRequest,
  now: Date
): McpPolicyRefusalReason | undefined {
  if (
    !isName(approval.approvalId) ||
    approval.approvalId.length < 8 ||
    typeof approval.approvedBy !== "string" ||
    approval.approvedBy.length === 0 ||
    approval.approvedBy.length > 128 ||
    typeof approval.issuedAt !== "string" ||
    typeof approval.expiresAt !== "string" ||
    !isoInstantPattern.test(approval.issuedAt) ||
    !isoInstantPattern.test(approval.expiresAt)
  ) {
    return "approval_reference_invalid";
  }
  const issuedAt = Date.parse(approval.issuedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt) || expiresAt <= issuedAt) return "approval_reference_invalid";
  // Both ends are enforced. An approval issued in the future is not an approval that has not
  // expired yet: it is a reference whose window was written by something other than the approval
  // that supposedly produced it, so it is refused as invalid rather than honoured until its end.
  // The same reason covers an over-long window, because both are defects in the reference itself
  // rather than the ordinary, expected passage of time that `approval_reference_expired` records.
  if (issuedAt > now.getTime()) return "approval_reference_invalid";
  if (expiresAt - issuedAt > maxApprovalWindowMs) return "approval_reference_invalid";
  if (approval.connectorId !== request.connectorId || approval.operation !== request.operation) {
    return "approval_reference_mismatch";
  }
  // Strict boundary: an approval is over at its expiry instant, not one millisecond after it.
  if (expiresAt <= now.getTime()) return "approval_reference_expired";
  return undefined;
}

/** Exact `type/subtype`: no wildcard, no `; charset=` parameter, so a match cannot be widened. */
const contentTypePattern = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function contentTypesInvalid(values: readonly string[]): boolean {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) return true;
  return values.some((value) => typeof value !== "string" || !contentTypePattern.test(value));
}

function limitsInvalid(config: McpLayerConfig): boolean {
  const {
    callTimeoutMs,
    maxAttempts,
    maxCallsPerExchange,
    maxResultBytes,
    maxRedirects,
    allowedContentTypes,
    maxConcurrentCalls
  } = config.limits;
  return (
    !Number.isInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > 30_000 ||
    !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
    !Number.isInteger(maxCallsPerExchange) || maxCallsPerExchange < 1 || maxCallsPerExchange > 16 ||
    !Number.isInteger(maxResultBytes) || maxResultBytes < 1 || maxResultBytes > 262_144 ||
    // Following a redirect is opt-in and narrowly bounded: the reviewed host must stay the host.
    !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 2 ||
    contentTypesInvalid(allowedContentTypes) ||
    !Number.isInteger(maxConcurrentCalls) || maxConcurrentCalls < 1 || maxConcurrentCalls > 8
  );
}

function findBinding(config: McpLayerConfig, connectorId: string): McpConnectorBinding | undefined {
  return config.connectors.find((binding) => binding.descriptor.id === connectorId);
}

function findOperation(binding: McpConnectorBinding, name: string): McpOperationDescriptor | undefined {
  return binding.descriptor.operations.find((candidate) => candidate.name === name);
}

export function evaluateConnectorCall(
  config: McpLayerConfig,
  request: McpCallRequest,
  runtime: RuntimeConfig,
  now: Date = new Date()
): McpPolicyDecision {
  // Default deny: an unconfigured or explicitly disabled layer answers before anything is parsed.
  if (config.enabled !== true) return refuse("connector_layer_disabled");

  // Environment gating. The runtime's own readiness rules are the source of truth for what
  // "safe production" means; this only refuses to attach an external connector unless they hold.
  if (runtime.environment === "production") {
    if (runtime.secretSource !== "managed") return refuse("production_requires_managed_secrets");
    if (runtime.authMode !== "gateway") return refuse("production_requires_gateway_auth");
  }

  if (
    request === null ||
    typeof request !== "object" ||
    !isName(request.connectorId) ||
    !isName(request.operation) ||
    request.input === null ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  ) {
    return refuse("request_invalid");
  }

  const binding = findBinding(config, request.connectorId);
  if (!binding) return refuse("unknown_connector");
  if (binding.enabled !== true) return refuse("connector_not_enabled");
  if (limitsInvalid(config)) return refuse("limits_invalid");

  // No wildcard can grant an operation, and a wildcard anywhere in a binding invalidates it:
  // a partial glob is how a read-only allowlist quietly becomes a write-capable one.
  if (hasWildcard(binding.allowedOperations) || hasWildcard(binding.allowedConsequentialOperations)) {
    return refuse("wildcard_not_permitted");
  }
  if (config.allowedHosts.some((host) => host.includes("*"))) return refuse("wildcard_not_permitted");

  let endpoint: URL;
  try {
    endpoint = new URL(binding.endpointUrl);
  } catch {
    return refuse("endpoint_url_invalid");
  }
  if (endpoint.protocol !== "https:") return refuse("endpoint_not_https");
  // Userinfo in the endpoint is a static credential arriving through configuration, which
  // `credentials.ts` and SECURITY.md say has nowhere to enter: a live client would turn
  // `https://user:pass@host/` into a Basic auth header. It is also two readings of one URL, since
  // the part before `@` looks like a host to a human and is not one to the parser.
  if (endpoint.username !== "" || endpoint.password !== "") return refuse("endpoint_userinfo_not_permitted");
  const host = canonicalizeHost(endpoint.hostname);
  if (metadataHosts.has(host)) return refuse("endpoint_host_metadata_service");
  if (isNonPublicHost(host)) return refuse("endpoint_host_not_public");
  // The allowlist is compared in the same canonical form as the endpoint host, so an entry that
  // differs only in case or in a trailing root dot neither silently fails to match nor matches a
  // host the checks above already refused. `config.ts` normalises at parse time; this is the
  // second half of the same rule, for a configuration assembled in code rather than from an env.
  if (!config.allowedHosts.some((entry) => canonicalizeHost(entry) === host)) {
    return refuse("endpoint_host_not_allowlisted");
  }

  // The endpoint handed onward carries the canonical host, so the transport connects to exactly
  // the string that was checked rather than to a variant form that differs from it.
  endpoint.hostname = host;

  const operation = findOperation(binding, request.operation);
  if (!operation) return refuse("unknown_operation");
  if (!binding.allowedOperations.includes(operation.name)) return refuse("operation_not_allowlisted");

  let approvalId: string | undefined;
  if (operation.operationClass === "consequential") {
    if (request.approval === undefined) return refuse("consequential_operation_requires_approval");
    if (!binding.allowedConsequentialOperations.includes(operation.name)) {
      return refuse("consequential_operation_not_opted_in");
    }
    const failure = approvalFailure(request.approval, request, now);
    if (failure) return refuse(failure);
    approvalId = request.approval.approvalId;
  }

  const retryPermitted = operation.operationClass === "read-only" && operation.idempotent;
  const allowed: McpAllowedCall = {
    connectorId: binding.descriptor.id,
    provider: binding.descriptor.provider,
    operation: operation.name,
    operationClass: operation.operationClass,
    endpointUrl: endpoint.toString(),
    endpointHost: host,
    retryPermitted,
    timeoutMs: config.limits.callTimeoutMs,
    maxAttempts: retryPermitted ? config.limits.maxAttempts : 1,
    maxResultBytes: config.limits.maxResultBytes,
    maxRedirects: config.limits.maxRedirects,
    allowedContentTypes: [...config.limits.allowedContentTypes],
    ...(approvalId === undefined ? {} : { approvalId })
  };
  return { ok: true, allowed };
}
