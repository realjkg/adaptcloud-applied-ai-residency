import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const publicDir = join(root, "public");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

function fail(message) {
  throw new Error(`static security gate: ${message}`);
}

const forbiddenJavaScript = [
  ["innerHTML assignment", /\.\s*innerHTML\s*=/],
  ["outerHTML assignment", /\.\s*outerHTML\s*=/],
  ["insertAdjacentHTML", /\.\s*insertAdjacentHTML\s*\(/],
  ["document.write", /\bdocument\.write(?:ln)?\s*\(/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\s*\(/],
  ["srcdoc assignment", /\.\s*srcdoc\s*=/],
  ["event-handler attribute injection", /setAttribute\s*\(\s*["'`]on[a-z]+/i]
];

for (const file of await walk(publicDir)) {
  const extension = extname(file);
  const source = await readFile(file, "utf8");

  if (extension === ".js") {
    for (const [name, pattern] of forbiddenJavaScript) {
      if (pattern.test(source)) fail(`${file} contains forbidden ${name}`);
    }
  }

  if (extension === ".html") {
    if (/\son[a-z]+\s*=/i.test(source)) fail(`${file} contains an inline event handler`);
    if (/\b(?:href|src)\s*=\s*["']\s*javascript:/i.test(source)) fail(`${file} contains a javascript: URL`);
    if (/\bsrcdoc\s*=/i.test(source)) fail(`${file} contains srcdoc`);

    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const [, attributes, body] = match;
      if (!/\bsrc\s*=/.test(attributes)) fail(`${file} contains an inline script`);
      if (body.trim()) fail(`${file} contains script body content`);
    }
  }
}

const vercel = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
const globalHeaders = vercel.headers?.find(entry => entry.source === "/(.*)")?.headers ?? [];
const header = key => globalHeaders.find(item => item.key.toLowerCase() === key.toLowerCase())?.value;
const csp = header("Content-Security-Policy");

if (!csp) fail("Content-Security-Policy is missing from the global Vercel headers");

const requiredCspDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'"
];

for (const directive of requiredCspDirectives) {
  if (!csp.includes(directive)) fail(`CSP is missing: ${directive}`);
}

const requiredHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none"
};

for (const [key, expected] of Object.entries(requiredHeaders)) {
  if (header(key) !== expected) fail(`${key} must be ${expected}`);
}

process.stdout.write(`${JSON.stringify({ status: "ok", filesChecked: (await walk(publicDir)).length })}\n`);
