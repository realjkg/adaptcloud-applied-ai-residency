import { describe, expect, it } from "vitest";
import { mcpConfigFromEnvironment } from "../src/platform/mcp/config.js";
import { awsReadOnlyOperations, defaultMcpLimits } from "../src/platform/mcp/contracts.js";

const enabled = {
  MCP_CONNECTORS_ENABLED: "true",
  MCP_ALLOWED_HOSTS: "mcp.example-cloud.test",
  MCP_AWS_ENABLED: "true",
  MCP_AWS_ENDPOINT_URL: "https://mcp.example-cloud.test/aws",
  MCP_CREDENTIAL_MODE: "workload-identity"
} satisfies NodeJS.ProcessEnv;

describe("MCP operator configuration", () => {
  it("is off when nothing is configured", () => {
    const result = mcpConfigFromEnvironment({});
    expect(result.config.enabled).toBe(false);
    expect(result.config.connectors).toEqual([]);
    expect(result.credentialMode).toBe("denied");
  });

  it("requires the master switch even when connectors are fully described", () => {
    const result = mcpConfigFromEnvironment({ ...enabled, MCP_CONNECTORS_ENABLED: "false" });
    expect(result.config.enabled).toBe(false);
    expect(result.config.connectors).toEqual([]);
  });

  it("binds a connector only when its endpoint is supplied", () => {
    const bound = mcpConfigFromEnvironment(enabled);
    expect(bound.config.connectors).toHaveLength(1);
    expect(bound.config.connectors[0]?.descriptor.provider).toBe("aws");
    expect(bound.config.connectors[0]?.allowedOperations).toEqual([...awsReadOnlyOperations]);

    const unbound = mcpConfigFromEnvironment({ ...enabled, MCP_AWS_ENDPOINT_URL: "" });
    expect(unbound.config.connectors).toEqual([]);
    expect(unbound.notes.join(" ")).toContain("MCP_AWS_ENDPOINT_URL is unset");
  });

  it("defaults a bound connector to the read-only starter operations", () => {
    const result = mcpConfigFromEnvironment(enabled);
    expect(result.config.connectors[0]?.allowedConsequentialOperations).toEqual([]);
  });

  it("records an opt-in to a consequential operation instead of hiding it", () => {
    // Policy still demands a per-call approval reference. The note exists so the decision is
    // visible to a reviewer reading configuration rather than reading the policy engine.
    const result = mcpConfigFromEnvironment({ ...enabled, MCP_AWS_ALLOWED_CONSEQUENTIAL_OPERATIONS: "aws.set_budget" });
    expect(result.config.connectors[0]?.allowedConsequentialOperations).toEqual(["aws.set_budget"]);
    expect(result.notes.join(" ")).toContain("opts into consequential operations: aws.set_budget");
  });

  it("disables the whole layer when a limit is out of bounds rather than falling back quietly", () => {
    for (const [name, badValue] of [
      ["MCP_CALL_TIMEOUT_MS", "600000"],
      ["MCP_MAX_ATTEMPTS", "9"],
      ["MCP_MAX_CALLS_PER_EXCHANGE", "0"],
      ["MCP_MAX_RESULT_BYTES", "-1"]
    ] as const) {
      const result = mcpConfigFromEnvironment({ ...enabled, [name]: badValue });
      expect(result.config.enabled, `${name} must disable the layer`).toBe(false);
      expect(result.notes.join(" ")).toContain(name);
    }
  });

  it("keeps the documented limit defaults when none are supplied", () => {
    expect(mcpConfigFromEnvironment(enabled).config.limits).toEqual(defaultMcpLimits);
  });

  it("warns when the egress allowlist is empty because every endpoint is then refused", () => {
    const result = mcpConfigFromEnvironment({ ...enabled, MCP_ALLOWED_HOSTS: "" });
    expect(result.config.allowedHosts).toEqual([]);
    expect(result.notes.join(" ")).toContain("every endpoint is refused");
  });

  it("never accepts a credential through configuration", () => {
    const result = mcpConfigFromEnvironment({ ...enabled, MCP_CREDENTIAL_MODE: "static-key" });
    expect(result.credentialMode).toBe("denied");
    expect(result.notes.join(" ")).toContain("credentials stay denied");
    // The shape carries a mode, never material: no field anywhere holds a secret.
    expect(JSON.stringify(result)).not.toMatch(/secret|token|password|private_key/i);
  });

  it("says plainly when the layer is on but cannot resolve a credential", () => {
    const result = mcpConfigFromEnvironment({ ...enabled, MCP_CREDENTIAL_MODE: "denied" });
    expect(result.config.enabled).toBe(true);
    expect(result.notes.join(" ")).toContain("credential_unavailable");
  });

  it("stays disabled across every shipped reference profile", async () => {
    // The reference profiles are what a student copies. None of them may switch on an egress path.
    const { readFileSync } = await import("node:fs");
    for (const profile of ["development", "sandbox", "qa", "staging", "production"]) {
      const text = readFileSync(`config/${profile}-reference.env`, "utf8");
      const parsed: NodeJS.ProcessEnv = {};
      for (const line of text.split("\n")) {
        const separator = line.indexOf("=");
        if (line.startsWith("#") || separator < 1) continue;
        parsed[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      expect(mcpConfigFromEnvironment(parsed).config.enabled, `${profile} must not enable connectors`).toBe(false);
    }
  });
});
