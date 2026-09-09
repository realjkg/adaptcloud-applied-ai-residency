import type { ShortLivedCredential } from "./credentials.js";

/**
 * Transport seam for the MCP connector layer.
 *
 * NO LIVE NETWORK CALL EXISTS IN THIS CHANGE, and none may be added here without a separate
 * owner approval under CLAUDE.md rule 3. A live HTTP transport crosses the egress boundary in
 * `docs/WELL_ARCHITECTED.md` and requires, before any code: an owner decision recording which
 * hosts are approved, a threat model covering SSRF, response poisoning, credential replay, and
 * partner outage, plus tests for timeout, retry, refusal, and oversized-response behaviour. It
 * belongs in its own module so this seam and the stub stay network-free and the trust-boundary
 * scanner's `NET-B1` rule keeps pointing at exactly one reviewed egress point.
 *
 * The stub is deterministic and in-memory: labs and tests exercise the whole policy, credential,
 * and bounding path with no socket, so a green test run never depends on a provider being up.
 */

export interface McpTransportRequest {
  readonly connectorId: string;
  readonly operation: string;
  readonly endpointUrl: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly attempt: number;
  /** Opaque: the transport is the only component permitted to call `reveal()`. */
  readonly credential: ShortLivedCredential;
}

export type McpTransportResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: "transport_unavailable" | "transport_timeout" | "transport_refused" };

export interface McpTransport {
  readonly kind: "stub";
  invoke: (request: McpTransportRequest) => Promise<McpTransportResult>;
}

export type StubResponse = McpTransportResult | ((request: McpTransportRequest) => McpTransportResult | Promise<McpTransportResult>);

/**
 * Deterministic in-memory transport keyed by `connectorId/operation`. An unmapped operation is
 * refused rather than silently answered, so a test cannot pass on an accidental empty response.
 */
export function stubTransport(responses: Readonly<Record<string, StubResponse>>): McpTransport {
  return {
    kind: "stub",
    invoke: async (request) => {
      const response = responses[`${request.connectorId}/${request.operation}`];
      if (response === undefined) return { ok: false, reason: "transport_refused" };
      return typeof response === "function" ? await response(request) : response;
    }
  };
}
