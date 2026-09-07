import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("cloud deployment foundations", () => {
  it("keeps the GitHub workflow plan-only and uses short-lived cloud identity", () => {
    const workflow = read(".github/workflows/infrastructure.yml");
    expect(workflow).not.toMatch(/terraform\s+(?:-chdir=\S+\s+)?apply/);
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("aws-actions/configure-aws-credentials@v6");
    expect(workflow).toContain("google-github-actions/auth@v3");
    expect(workflow).not.toMatch(/aws-access-key-id|credentials_json/);
  });

  it.each(["aws", "gcp"])("requires immutable images and private ingress for %s", (target) => {
    const variables = read(`infra/${target}/variables.tf`);
    const main = read(`infra/${target}/main.tf`);
    expect(variables).toContain("@sha256:");
    expect(variables).toContain("otel_collector_image");
    expect(main).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(main).toMatch(/AUTH_MODE.*gateway/);
  });

  it("keeps AWS tasks private with rollback enabled", () => {
    const main = read("infra/aws/main.tf");
    expect(main).toContain("assign_public_ip = false");
    expect(main).toContain("deployment_circuit_breaker");
    expect(main).toContain("rollback = true");
  });

  it("keeps GCP invocation non-public", () => {
    const main = read("infra/gcp/main.tf");
    const variables = read("infra/gcp/variables.tf");
    expect(main).toContain('ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"');
    expect(variables).toContain('!contains(["allUsers", "allAuthenticatedUsers"]');
  });
});
