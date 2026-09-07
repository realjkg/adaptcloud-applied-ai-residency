export interface RequestEvent {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  outcome: "success" | "rejected" | "error";
}

export function writeRequestEvent(event: RequestEvent): void {
  process.stdout.write(`${JSON.stringify({ type: "request.completed", ...event })}\n`);
}
