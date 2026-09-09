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
  /**
   * Cancellation for this attempt. `registry.ts` aborts it when the call timeout wins, and a
   * transport MUST honour it: pass it into the HTTP client's per-request
   * options as its cancellation signal, stop reading the body, and destroy the socket. A transport that ignores the
   * signal turns the timeout into a bookkeeping fiction — the caller sees `transport_timeout`
   * while the request is still in flight, so the concurrency cap would bound frames rather than
   * sockets and a "cancelled" call would still reach the provider. `registry.ts` therefore holds
   * the concurrency slot until the returned promise settles, which means an unresponsive
   * transport consumes its slot for as long as it really runs.
   */
  readonly signal: AbortSignal;
  /** Opaque: the transport is the only component permitted to call `reveal()`. */
  readonly credential: ShortLivedCredential;
}

/**
 * A successful transport reports what it saw on the wire alongside the body. `contentType` and
 * `redirectCount` are checked by `registry.ts`, not here, so the stub can exercise both refusals
 * today and a future live transport inherits the check instead of reimplementing it. Both are
 * optional because a transport that cannot observe them must not be forced to invent a value;
 * what it does report is enforced.
 */
export type McpTransportResult =
  | {
      readonly ok: true;
      readonly body: unknown;
      /** Media type only, no parameters. `application/json; charset=utf-8` is normalized by the caller. */
      readonly contentType?: string;
      /** Redirects followed to reach this body. The default limit is zero. */
      readonly redirectCount?: number;
    }
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
