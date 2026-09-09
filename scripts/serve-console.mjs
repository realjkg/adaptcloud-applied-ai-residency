#!/usr/bin/env node
// Development-only host for the scenario console.
//
// It serves three static files from a fixed table and proxies /api to the local sample API so the
// browser stays same-origin. It is not part of the deployed surface: public/ is what Vercel
// publishes, and the runtime container copies only dist/. Keeping the console here means the
// static walkthrough boundary in docs/VERCEL_WALKTHROUGH.md stays intact.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const port = Number(value("port", "3300"));
const api = value("api", "http://127.0.0.1:3000");
const environment = process.env.APP_ENV ?? "development";

if (environment !== "development" && environment !== "sandbox" && environment !== "test") {
  process.stderr.write(`Refusing to start: the console is a development tool and APP_ENV is "${environment}".\n`);
  process.exit(2);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api)) {
  process.stderr.write("Refusing to start: --api must point at a local sample API.\n");
  process.exit(2);
}

// An explicit table rather than a path join. Serving a directory by joining a request path is how
// a console becomes a file-disclosure bug; there is nothing to traverse here.
const files = new Map([
  ["/", ["examples/console/index.html", "text/html; charset=utf-8"]],
  ["/console.js", ["examples/console/console.js", "text/javascript; charset=utf-8"]],
  ["/console.css", ["examples/console/console.css", "text/css; charset=utf-8"]],
  ["/fixtures/commercial.json", ["examples/labs/commercial.json", "application/json; charset=utf-8"]],
  ["/fixtures/payments.json", ["examples/labs/payments.json", "application/json; charset=utf-8"]],
  ["/fixtures/insurance.json", ["examples/labs/insurance.json", "application/json; charset=utf-8"]]
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://console.local");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");

  const staticFile = files.get(url.pathname);
  if (staticFile && request.method === "GET") {
    const [path, contentType] = staticFile;
    try {
      const body = await readFile(resolve(process.cwd(), path));
      response.writeHead(200, { "content-type": contentType }).end(body);
    } catch {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) {
        response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "request_too_large" }));
        return;
      }
      chunks.push(chunk);
    }
    try {
      const upstream = await fetch(`${api}${url.pathname}${url.search}`, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: request.method === "GET" ? undefined : Buffer.concat(chunks),
        signal: AbortSignal.timeout(30_000)
      });
      const body = await upstream.text();
      response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" }).end(body);
    } catch {
      response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "sample_api_unreachable", hint: `start it with npm run dev, then retry against ${api}` }));
    }
    return;
  }

  response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Scenario console on http://127.0.0.1:${port} proxying ${api}\nRun the sample API separately with npm run dev.\n`);
});
