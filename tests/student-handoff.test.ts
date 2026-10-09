import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

// Action refs (owner/repo@ref) declared in a workflow's `uses:` lines.
const actionRefs = (workflow: string): string[] =>
  [...workflow.matchAll(/uses:\s*(\S+)/g)]
    .map((match) => match[1] ?? "")
    .filter((ref) => ref.includes("@"));

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
    const dockerfile = read("Dockerfile");
    expect(script).toContain("--read-only");
    expect(script).toContain("--cap-drop ALL");
    expect(script).toContain("no-new-privileges");
    expect(script).toContain('test "$status" = "413"');
    expect(script).toContain("/api/v1/scenarios/$scenario/assess");
    expect(script).toContain('"terraformRoot":"infra/gcp"');
    expect(script).toContain("scenarios/unknown/assess");
    expect(script).toContain('test "$status" = "401"');
    expect(script).toContain('"type":"service.shutdown"');
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules");
    expect(dockerfile).toContain("USER node");
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
    // Derived, not restated: expectations come from the workflow file itself,
    // so a Dependabot bump can never split this test from CI again.
    const uses = actionRefs(workflow);
    expect(uses.some((ref) => ref.startsWith("anchore/sbom-action@"))).toBe(true);
    expect(uses.some((ref) => ref.startsWith("aquasecurity/trivy-action@"))).toBe(true);
    expect(workflow).toContain("scanners: vuln,secret,misconfig");
    expect(workflow).toContain("severity: HIGH,CRITICAL");
    expect(workflow).toContain("exit-code: 1");
  });

  it("pins every action ref to a version tag or full commit SHA", () => {
    const uses = actionRefs(read(".github/workflows/student-handoff.yml"));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      const pinned = ref.slice(ref.lastIndexOf("@") + 1);
      const thirdParty = !ref.startsWith("actions/");
      // First-party actions may track a major tag; third-party actions must
      // pin a full vX.Y.Z tag or a 40-char SHA — never a floating branch ref.
      const shape = thirdParty
        ? /^v\d+\.\d+\.\d+$|^[0-9a-f]{40}$/
        : /^v\d+(\.\d+)*$|^[0-9a-f]{40}$/;
      expect(pinned, `unpinned action ref: ${ref}`).toMatch(shape);
    }
  });
});
