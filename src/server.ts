import { createServer } from "node:http";
import { runAssessment } from "./agent/workflow.js";

const port = Number(process.env.PORT ?? 3000);
const maxBodyBytes = 64 * 1024;

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/assess") {
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    return;
  }
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
    const message = error instanceof Error ? error.message : "invalid_request";
    response.writeHead(message === "request_too_large" ? 413 : 400).end(JSON.stringify({ error: message }));
  }
});

server.listen(port, "0.0.0.0", () => process.stdout.write(`Adapt Cloud sample agent listening on ${port}\n`));
