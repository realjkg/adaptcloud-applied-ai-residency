import { writeAuditEvent, type AuditEvent } from "../observability.js";
import type { McpOperationClass, McpRefusalReason } from "./contracts.js";

/**
 * Audit record for one MCP connector call (SECURITY.md: metadata and control outcomes only).
 *
 * A refusal that leaves no trace is indistinguishable from a call that never happened, so every
 * path through `registry.ts` — policy refusal, runtime refusal, success — emits exactly one
 * event. The shape is closed and scalar-only, which is the control: there is no field that can
 * hold the tool input, the result body, an endpoint path or query, a credential, a credential
 * error message, or any free text the connector chose. `connectorId` and `operation` are
 * name-checked before they are recorded, because on an invalid request they originate from the
 * caller rather than from operator configuration.
 */
export type McpAuditEvent = {
  readonly type: "mcp.connector.call";
  readonly connectorId: string;
  readonly operation: string;
  readonly operationClass: McpOperationClass | "unknown";
  readonly decision: "allowed" | "refused";
  readonly reason?: McpRefusalReason;
  readonly attempts: number;
  readonly durationMs: number;
  readonly resultBytes: number;
  readonly approvalId?: string;
};

export type McpAuditSink = (event: McpAuditEvent) => void;

/** Placeholder for a name that failed validation; the rejected text itself is never recorded. */
export const unnamedAuditValue = "unspecified";

const namePattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function auditName(value: unknown): string {
  return typeof value === "string" && namePattern.test(value) ? value : unnamedAuditValue;
}

/** Default sink: the repository's own event writer. Tests and labs inject a collector instead. */
export const defaultMcpAuditSink: McpAuditSink = (event) => {
  writeAuditEvent(event satisfies AuditEvent);
};

/** Never let an audit sink failure change a call outcome; the call already happened either way. */
export function emitMcpAuditEvent(sink: McpAuditSink, event: McpAuditEvent): void {
  try {
    sink(event);
  } catch {
    // A broken sink is an observability fault, not an authorization result.
  }
}
