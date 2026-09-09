export interface RequestEvent {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  outcome: "success" | "rejected" | "error";
}

/**
 * Structured event record. The value type is deliberately limited to scalars: an event that
 * cannot hold an object or an array cannot accidentally carry a prompt body, a tool input, or a
 * connector result (SECURITY.md: logs contain metadata and control outcomes, not content).
 */
export interface AuditEvent {
  readonly type: string;
  readonly [field: string]: string | number | boolean | undefined;
}

/** Single line, single writer: every structured event in the process leaves through here. */
export function writeAuditEvent(event: AuditEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function writeRequestEvent(event: RequestEvent): void {
  writeAuditEvent({ type: "request.completed", ...event });
}
