import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyTwinFault, checkDigitalTwin, TWIN_FAULTS, TWIN_FINDING_IDS } from "../src/labs/digital-twin.js";
import baseline from "../examples/labs/digital-twin.json" with { type: "json" };

const guide = readFileSync("docs/DIGITAL_TWIN_NETWORK_LAB.md", "utf8");

describe("digital twin baseline", () => {
  it("passes the synthetic reference model for human review, not as production approval", () => {
    const result = checkDigitalTwin(baseline);
    expect(result.status).toBe("ready_for_human_review");
    expect(result.humanApprovalRequired).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ components: 6, flows: 2 });
  });

  it("covers every vendor named in the lab", () => {
    const vendors = new Set((baseline.components as Array<{ vendor: string }>).map((node) => node.vendor));
    expect([...vendors].sort()).toEqual(["cisco-meraki", "cloudflare", "f5", "paloalto", "synthetic-app"]);
  });
});

describe("digital twin fault catalog", () => {
  it.each(TWIN_FAULTS.map((fault) => [fault.id, fault.expectedFinding] as const))("%s is detected as %s", (id, expectedFinding) => {
    const result = checkDigitalTwin(applyTwinFault(baseline, id));
    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.id)).toContain(expectedFinding);
  });

  it("never mutates the baseline spec", () => {
    const before = JSON.stringify(baseline);
    for (const fault of TWIN_FAULTS) applyTwinFault(baseline, fault.id);
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it("gives every fault a unique id and an expected finding the checker can emit", () => {
    const ids = TWIN_FAULTS.map((fault) => fault.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fault of TWIN_FAULTS) expect(TWIN_FINDING_IDS).toContain(fault.expectedFinding);
  });

  it("is named in the lab guide, so the exercise cannot drift from the checker", () => {
    for (const fault of TWIN_FAULTS) expect(guide).toContain(`\`${fault.id}\``);
  });

  it("refuses to inject an unknown fault", () => {
    expect(() => applyTwinFault(baseline, "F99-missing")).toThrow("unknown twin fault");
  });
});

describe("digital twin control rules", () => {
  const clone = () => structuredClone(baseline) as Record<string, any>;

  it("refuses a spec that is not marked synthetic", () => {
    const twin = clone();
    twin.synthetic = false;
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-SYNTHETIC" }));
  });

  it("refuses an internet flow that terminates at the application without the edge", () => {
    const twin = clone();
    twin.flows[0].path = ["pa-ngfw-dmz", "f5-bigip-adc", "app-web-pool"];
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-PATH", subject: "app-https-inbound" }));
  });

  it("refuses a flow that references an undeclared component", () => {
    const twin = clone();
    twin.flows[1].path = ["meraki-mx-branch", "ghost-device", "f5-bigip-adc", "app-web-pool"];
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-REF", subject: "branch-to-app" }));
  });

  it("refuses duplicate component identifiers", () => {
    const twin = clone();
    twin.components.push({ ...twin.components[0] });
    expect(checkDigitalTwin(twin).findings.map((finding) => finding.id)).toContain("TWIN-UNIQUE");
  });

  it("refuses a missing lab role rather than passing a partial model", () => {
    const twin = clone();
    twin.components = twin.components.filter((node: { role: string }) => node.role !== "adc-ltm");
    twin.flows = [];
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-ROLE", subject: "adc-ltm" }));
  });

  it("refuses an address outside documentation and private ranges, including near-miss ranges", () => {
    for (const address of ["8.8.8.8", "172.32.0.1", "198.51.101.1", "256.0.0.1", "10.0.0"]) {
      const twin = clone();
      twin.components[4].address = address;
      expect(checkDigitalTwin(twin).findings, address).toContainEqual(expect.objectContaining({ id: "TWIN-ADDR" }));
    }
  });

  it("accepts documentation and private boundary addresses", () => {
    const twin = clone();
    twin.components[0].address = "192.0.2.255";
    twin.components[4].address = "172.31.255.254";
    expect(checkDigitalTwin(twin).findings.filter((finding) => finding.id === "TWIN-ADDR")).toEqual([]);
  });

  it("refuses a Palo Alto NGFW record labeled with the wrong vendor", () => {
    const twin = clone();
    twin.components[1].vendor = "cloudflare";
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-ROLE", subject: "pa-ngfw-dmz" }));
  });

  it("refuses a vendor outside the lab allowlist", () => {
    const twin = clone();
    twin.components[1].vendor = "unvetted-vendor";
    expect(checkDigitalTwin(twin).findings.map((finding) => finding.id)).toContain("TWIN-VENDOR");
  });

  it("refuses an HTTPS flow without a termination point on its path", () => {
    const twin = clone();
    delete twin.flows[0].tlsTermination;
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-TLS", subject: "app-https-inbound" }));
  });

  it("refuses an internet flow that touches the management zone", () => {
    const twin = clone();
    twin.flows[0].path = ["cf-edge-waf", "pa-ngfw-dmz", "panorama-mgmt", "f5-bigip-adc", "app-web-pool"];
    expect(checkDigitalTwin(twin).findings).toContainEqual(expect.objectContaining({ id: "TWIN-MGMT", subject: "app-https-inbound" }));
  });
});

describe("digital twin untrusted input", () => {
  it("returns a shape finding for non-object input without throwing", () => {
    for (const input of [null, "twin", 42, []]) {
      const result = checkDigitalTwin(input);
      expect(result.status).toBe("blocked");
      expect(result.findings.map((finding) => finding.id)).toEqual(["TWIN-SHAPE"]);
    }
  });

  it("reports malformed components by position and never echoes the value", () => {
    const twin = structuredClone(baseline) as Record<string, any>;
    twin.components[2] = { id: "f5-bigip-adc", vendor: { nested: "SYNTH-LEAK-CHECK" }, role: "adc-ltm", zone: "dmz", address: "10.20.0.10" };
    const result = checkDigitalTwin(twin);
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "TWIN-SHAPE", subject: "components[2]" }));
    expect(JSON.stringify(result)).not.toContain("SYNTH-LEAK-CHECK");
  });

  it("refuses credential-shaped fields at any depth and reports only the key path", () => {
    const twin = structuredClone(baseline) as Record<string, any>;
    twin.components[2].managementCredentials = { api_key: "SYNTH-NOT-A-REAL-KEY-VALUE" };
    const result = checkDigitalTwin(twin);
    const secrets = result.findings.filter((finding) => finding.id === "TWIN-SECRET").map((finding) => finding.subject);
    expect(secrets).toEqual(expect.arrayContaining(["components[2].managementCredentials", "components[2].managementCredentials.api_key"]));
    expect(JSON.stringify(result)).not.toContain("SYNTH-NOT-A-REAL-KEY-VALUE");
  });

  it("requires arrays for components and flows", () => {
    const result = checkDigitalTwin({ twinId: "x", synthetic: true, components: "not-a-list", flows: [] });
    expect(result.findings.map((finding) => finding.id)).toContain("TWIN-SHAPE");
  });
});
