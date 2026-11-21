// The synthetic registry: fixtures for learner deployments and tests. Reserved: a live inventory may not reuse these
// aliases, scopes, or Meraki networks (see target-resolution.mjs).

const pan = (group, serial) => ({ vendor: "paloalto", label: `Simulated firewall ${serial}`, environment: "lab", disposable: true, mode: "simulator", scope: { managementHost: "panorama-dfw.lab.example", deviceGroup: group, firewallSerial: serial, vsys: "vsys1" }, commitAdmin: "sim-api", capabilities: ["address-object.create", "address-object.delete"] });
const mx = (networkId, serial, label) => ({ vendor: "meraki", label, environment: "lab", disposable: true, mode: "simulator", scope: { organizationId: "790001", networkId, applianceSerial: serial }, capabilities: ["l3-firewall-rule.add", "l3-firewall-rule.remove", "sdwan.uplink-preference.set"] });

const cf = (zoneId, zoneName, label) => ({ vendor: "cloudflare", label, environment: "lab", disposable: true, mode: "simulator", scope: { accountId: "a".repeat(32), zoneId, zoneName }, capabilities: ["waf-custom-rule.add", "redirect-rule.add", "cache-rule.add", "edge-rule.remove"] });

export const SIMULATOR_TARGETS = new Map([
  ["pan-dfw-edge", pan("DG-DFW-EDGE", "019801234560")],
  ["pan-aus-edge", pan("DG-AUS-EDGE", "019801234561")],
  ["mx-aus-branch", mx("L_790001000000000001", "Q2MX-AUS1-LAB1", "Simulated MX, Austin branch")],
  ["mx-plano-branch", mx("L_790001000000000002", "Q2MX-PLN1-LAB2", "Simulated MX, Plano branch")],
  ["cf-edge-a", cf("1".repeat(32), "edge-a.shop.example", "Simulated Cloudflare zone, lab A")],
  ["cf-edge-b", cf("2".repeat(32), "edge-b.shop.example", "Simulated Cloudflare zone, lab B")]
]);
