#!/usr/bin/env node
// A small development server for the viewer. Read-only, bound to localhost, and limited to the viewer's own files
// and the snapshot directory. The viewer is plain static files and runs from any static host. This is for local use.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "render.js": "text/javascript; charset=utf-8", "layout.js": "text/javascript; charset=utf-8", "snapshot.js": "text/javascript; charset=utf-8", "drawio.js": "text/javascript; charset=utf-8", "viewer.css": "text/css; charset=utf-8" };
const SNAPSHOT_FILE = /^[A-Za-z0-9._-]+\.json$/;

const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

export function createViewerServer({ snapshotsDir = join(HERE, "..", "snapshots") } = {}) {
  return createServer(async (request, response) => {
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      response.writeHead(status, { ...HEADERS, "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") return send(405, "method not allowed");
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      return send(400, "bad request");
    }
    const parts = pathname.split("/").filter(Boolean);
    try {
      if (parts.length === 0) return send(200, await readFile(join(HERE, "index.html")), ASSETS["index.html"]);
      if (parts.length === 1 && ASSETS[parts[0]]) return send(200, await readFile(join(HERE, parts[0])), ASSETS[parts[0]]);
      if (parts.length === 2 && parts[0] === "snapshots" && SNAPSHOT_FILE.test(parts[1])) return send(200, await readFile(join(snapshotsDir, parts[1])), "application/json; charset=utf-8");
    } catch {
      return send(404, "not found");
    }
    return send(404, "not found");
  });
}

export async function main(argv) {
  const port = Number(argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3400);
  const server = createViewerServer();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Topology viewer on http://127.0.0.1:${server.address().port}/`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
