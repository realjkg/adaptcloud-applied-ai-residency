import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Vercel walkthrough contract", () => {
  it("publishes a static output directory after the TypeScript build", () => {
    const config = JSON.parse(read("vercel.json")) as Record<string, unknown>;
    expect(config.buildCommand).toBe("npm run build");
    expect(config.outputDirectory).toBe("public");
    expect(read("public/index.html")).toContain("/app.js");
    expect(read("public/index.html")).toContain("/styles.css");
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
