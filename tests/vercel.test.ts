import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Vercel walkthrough contract", () => {
  it("forces a static-only deployment without a framework build", () => {
    const config = JSON.parse(read("vercel.json")) as Record<string, unknown>;
    expect(config.framework).toBeNull();
    expect(config.buildCommand).toBeNull();
    expect(config.outputDirectory).toBe("public");
    expect(read("public/index.html")).toContain("/app.js");
    expect(read("public/index.html")).toContain("/styles.css");
  });

  it("provides an external deployment smoke check", () => {
    const smoke = read("scripts/check-static-deployment.mjs");
    expect(smoke).toContain("DEPLOYMENT_URL");
    expect(smoke).toContain("FUNCTION_INVOCATION_FAILED");
    expect(smoke).toContain("Adapt Cloud Applied AI Engineer Residency");
  });

  it("keeps the browser walkthrough synthetic and disconnected", () => {
    const client = read("public/app.js");
    expect(client).toContain('"adaptcloud.cloud_mutation": false');
    expect(client).toContain('"adaptcloud.export_enabled": false');
    expect(client).not.toMatch(/fetch\s*\(|XMLHttpRequest|ANTHROPIC_API_KEY/);
  });

  it("pins the Vercel and container runtime to Node 22", () => {
    const packageJson = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(packageJson.engines.node).toBe("22.x");
  });
});
