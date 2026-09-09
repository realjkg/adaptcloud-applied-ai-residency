import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("guided environment promotion workflow", () => {
  it("treats QA as a first-class runtime and cloud-plan environment", () => {
    expect(read("config/qa-reference.env")).toContain("APP_ENV=qa");
    expect(read(".github/workflows/quality.yml")).toContain("development, sandbox, qa, staging, production");
    expect(read(".github/workflows/infrastructure.yml")).toContain("sandbox, qa, staging, production");
    expect(read("infra/aws/variables.tf")).toContain('["sandbox", "qa", "staging", "production"]');
    expect(read("infra/gcp/variables.tf")).toContain('["sandbox", "qa", "staging", "production"]');
  });

  it("evaluates stages in order without cloud mutation authority", () => {
    const workflow = read(".github/workflows/environment-promotion.yml");
    expect(workflow).toContain("for environment in development sandbox qa staging production");
    expect(workflow).toContain("npm run test:unit");
    expect(workflow).toContain("npm run lab:simulate");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toMatch(/terraform\s+(?:-chdir=[^\s]+\s+)?apply/);
  });

  it("keeps production authorization outside the emulator", () => {
    const evaluator = read("src/platform/promotion.ts");
    const guide = read("docs/ENVIRONMENT_PROMOTION_LAB.md");
    expect(evaluator).toContain("deploymentAuthorized: false");
    expect(guide).toContain("`deploymentAuthorized` is always `false`");
    expect(guide).toContain("evidenceMode: simulation");
  });

  it("documents the connector gate and the threat model that stands behind it", () => {
    const guide = read("docs/ENVIRONMENT_PROMOTION_LAB.md");
    expect(guide).toContain("`connector-review` gate is a sandbox gate under the security pillar");
    expect(guide).toContain("docs/adr/0002-mcp-connector-threat-model.md");

    const adr = read("docs/adr/0002-mcp-connector-threat-model.md");
    expect(adr).toContain("**No live transport is authorised.**");
    for (const threat of ["DNS rebinding", "Redirects", "request smuggling", "instance metadata", "connector-review"]) {
      expect(adr).toContain(threat);
    }
    expect(read("docs/templates/PROMOTION_EVIDENCE.md")).toContain("MCP connector state per environment");
  });
});
