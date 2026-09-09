import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("local scenario console", () => {
  it("stays outside the deployed static surface", () => {
    // public/ is what Vercel publishes and the console must never land there, or the walkthrough
    // stops being static and the CSP in vercel.json starts blocking its own page.
    const vercel = JSON.parse(read("vercel.json")) as { outputDirectory: string };
    expect(vercel.outputDirectory).toBe("public");
    expect(() => read("public/console.js")).toThrow();
    expect(read("examples/console/index.html")).toContain("Scenario console");
    // The runtime image copies dist/ only, so a dev tool under examples/ cannot reach production.
    expect(read("Dockerfile")).not.toContain("COPY --from=build --chown=node:node /app/examples");
  });

  it("holds no credential and never sends one from the browser", () => {
    const client = read("examples/console/console.js");
    const markup = read("examples/console/index.html");
    for (const source of [client, markup]) {
      expect(source).not.toMatch(/ANTHROPIC_API_KEY|x-api-key|sk-ant-|AWS_SECRET|authorization:/i);
    }
    expect(client).toContain("never holds a credential");
  });

  it("renders server content as text so a finding message cannot become markup", () => {
    const client = read("examples/console/console.js");
    expect(client).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(client).toContain("textContent");
  });

  it("refuses to run outside a development environment", () => {
    const host = read("scripts/serve-console.mjs");
    expect(host).toContain('environment !== "development"');
    expect(host).toContain("process.exit(2)");
    expect(host).toContain("--api must point at a local sample API");
  });

  it("serves a fixed file table rather than joining a request path", () => {
    // Joining a user-supplied path onto a directory is how a console becomes a file-disclosure
    // bug. There is nothing to traverse when the table is explicit.
    const host = read("scripts/serve-console.mjs");
    expect(host).toContain("const files = new Map([");
    expect(host).not.toMatch(/join\(\s*(process\.cwd\(\)|root|base)\s*,\s*url\./);
    expect(host).toContain("files.get(url.pathname)");
  });

  it("bounds the proxied request like the sample API does", () => {
    const host = read("scripts/serve-console.mjs");
    expect(host).toContain("64 * 1024");
    expect(host).toContain("413");
    expect(host).toContain("AbortSignal.timeout(30_000)");
  });
});
