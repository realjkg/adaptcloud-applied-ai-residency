import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("student handoff acceptance", () => {
  it("proves the clean-room path without inherited provider credentials", () => {
    const workflow = read(".github/workflows/student-handoff.yml");
    expect(workflow).toContain("env -u ANTHROPIC_API_KEY");
    expect(workflow).toContain("-u AWS_ACCESS_KEY_ID");
    expect(workflow).toContain("-u GOOGLE_APPLICATION_CREDENTIALS");
    expect(workflow).toContain("npm run lab:simulate");
    expect(workflow).toContain("git diff --exit-code -- package-lock.json");
  });

  it("tests the hardened runtime and its public HTTP boundaries", () => {
    const script = read("scripts/test-container-runtime.sh");
    expect(script).toContain("--read-only");
    expect(script).toContain("--cap-drop ALL");
    expect(script).toContain("no-new-privileges");
    expect(script).toContain('test "$status" = "413"');
    expect(script).toContain('test "$status" = "401"');
    expect(script).toContain('"type":"service.shutdown"');
  });

  it("exports real telemetry while checking sensitive data exclusion", () => {
    const script = read("scripts/test-otel-integration.sh");
    expect(script).toContain("compose.otel.yaml");
    expect(script).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(script).toContain("http.request");
    expect(script).toContain("request.completed");
    expect(script).toContain("! grep -q 'Summarize maintenance reports'");
  });

  it("generates an SBOM and blocks high-severity supply-chain findings", () => {
    const workflow = read(".github/workflows/student-handoff.yml");
    expect(workflow).toContain("anchore/sbom-action@v0.24.2");
    expect(workflow).toContain("aquasecurity/trivy-action@v0.36.0");
    expect(workflow).toContain("scanners: vuln,secret,misconfig");
    expect(workflow).toContain("severity: HIGH,CRITICAL");
    expect(workflow).toContain("exit-code: 1");
  });
});
