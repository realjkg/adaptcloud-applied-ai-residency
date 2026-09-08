import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("cloud deployment foundations", () => {
  it("gates infrastructure on unit tests and uses short-lived cloud identity", () => {
    const workflow = read(".github/workflows/infrastructure.yml");
    expect(workflow).toContain("needs: unit-tests");
    expect(workflow).toContain("npm run test:unit");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("aws-actions/configure-aws-credentials@v6");
    expect(workflow).toContain("google-github-actions/auth@v3");
    expect(workflow).not.toMatch(/aws-access-key-id|credentials_json/);
  });

  it("allows mutation only in a student sandbox with explicit confirmation", () => {
    const workflow = read(".github/workflows/infrastructure.yml");
    const guard = read("scripts/guard-infrastructure.mjs");
    expect(workflow).toContain("node scripts/guard-infrastructure.mjs");
    expect(guard).toContain("APPLY MY SANDBOX");
    expect(guard).toContain("DESTROY MY SANDBOX");
    expect(workflow).toMatch(/terraform\s+-chdir=infra\/aws\s+apply/);
    expect(workflow).toMatch(/terraform\s+-chdir=infra\/gcp\s+apply/);
    expect(workflow).toContain("AWS_TERRAFORM_SANDBOX_ROLE_ARN");
    expect(workflow).toContain("GCP_TERRAFORM_SANDBOX_SERVICE_ACCOUNT");
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
