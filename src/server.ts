import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { runAssessment } from "./agent/workflow.js";
import { writeRequestEvent } from "./platform/observability.js";
import { assessRuntimeReadiness, assertProductionReady, runtimeConfigFromEnvironment } from "./platform/runtime.js";

const runtime = runtimeConfigFromEnvironment();
assertProductionReady(runtime);
const port = runtime.port;
const maxBodyBytes = 64 * 1024;
let activeRequests = 0;

const server = createServer(async (request, response) => {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const route = new URL(request.url ?? "/", "http://service.local").pathname;
  let outcome: "success" | "rejected" | "error" = "success";
  response.setHeader("x-request-id", requestId);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.on("finish", () => writeRequestEvent({
    requestId,
    method: request.method ?? "UNKNOWN",
    route,
    status: response.statusCode,
    durationMs: Math.round(performance.now() - startedAt),
    outcome
  }));
  if (request.method === "GET" && (route === "/health" || route === "/health/live")) {
    response.writeHead(200).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method === "GET" && route === "/health/ready") {
    const blockers = assessRuntimeReadiness(runtime).filter((finding) => finding.severity === "blocker");
    const ready = runtime.environment !== "production" || blockers.length === 0;
    outcome = ready ? "success" : "rejected";
    response.writeHead(ready ? 200 : 503).end(JSON.stringify({ status: ready ? "ready" : "not_ready", environment: runtime.environment }));
    return;
  }
  if (request.method !== "POST" || route !== "/api/assess") {
    outcome = "rejected";
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (runtime.authMode === "gateway" && !request.headers["x-authenticated-subject"]) {
    outcome = "rejected";
    response.writeHead(401).end(JSON.stringify({ error: "authentication_required" }));
    return;
  }
  if (activeRequests >= runtime.maxConcurrentRequests) {
    outcome = "rejected";
    response.setHeader("retry-after", "1");
    response.writeHead(503).end(JSON.stringify({ error: "capacity_exceeded" }));
    return;
  }
  activeRequests += 1;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) throw new Error("request_too_large");
      chunks.push(buffer);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    response.writeHead(200).end(JSON.stringify(await runAssessment(input)));
  } catch (error) {
    outcome = "error";
    const message = error instanceof Error ? error.message : "invalid_request";
    response.writeHead(message === "request_too_large" ? 413 : 400).end(JSON.stringify({ error: message }));
  } finally {
    activeRequests -= 1;
  }
});

server.requestTimeout = runtime.requestTimeoutMs;
server.headersTimeout = Math.min(runtime.requestTimeoutMs, 60_000);

function shutdown(signal: string): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), runtime.requestTimeoutMs).unref();
  process.stdout.write(`${JSON.stringify({ type: "service.shutdown", signal })}\n`);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, "0.0.0.0", () => process.stdout.write(`Adapt Cloud sample agent listening on ${port}\n`));
