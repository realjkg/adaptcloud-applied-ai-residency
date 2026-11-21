import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHECKS, isLabAddress, within } from "../tools/health.mjs";
import { DEFAULT_CONFIG, runAgent } from "../tools/health-agent.mjs";
import { loadStages } from "../tools/twin-sequence.mjs";

const stages = loadStages();
const reference = () => JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
const checklist = readFileSync(fileURLToPath(new URL("../docs/CHECKLIST.md", import.meta.url)), "utf8");

const failingIds = (config, until) => {
  const report = runAgent({ stages, config, until });
  return report.halted ? report.halted.failing : [];
};

test("the reference config is healthy through every stage", () => {
  const report = runAgent({ stages, config: reference() });
  assert.equal(report.status, "healthy");
  assert.equal(report.through, "12");
  assert.equal(report.stages.length, 12);
});

test("the checklist lists exactly the checks that exist", () => {
  const listed = [...checklist.matchAll(/\*\*(HC-\d\d-[A-Z-]+)\*\*/g)].map((match) => match[1]).sort();
  assert.deepEqual(listed, CHECKS.map((check) => check.id).sort());
});

test("every check has a stage that exists and a unique id", () => {
  const ids = CHECKS.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length);
  const stageIds = new Set(["00", ...stages.map((stage) => stage.id)]);
  for (const check of CHECKS) assert.ok(stageIds.has(check.stage), `${check.id} names an unknown stage`);
});

test("every stage owns at least one check", () => {
  for (const stage of stages) assert.ok(CHECKS.some((check) => check.stage === stage.id), `stage ${stage.id} has no check`);
});

test("the starter config halts at stage 01 because the plan is missing", () => {
  const starter = JSON.parse(readFileSync(fileURLToPath(new URL("../config/starter-config.json", import.meta.url)), "utf8"));
  const report = runAgent({ stages, config: starter });
  assert.equal(report.status, "halted");
  assert.equal(report.halted.stage, "01");
  assert.deepEqual(report.halted.failing, ["HC-01-PLAN"]);
});

test("a partial build is healthy through the stages that exist, and the agent stops there", () => {
  const partial = reference();
  delete partial.cloudflare;
  delete partial.meraki;
  delete partial.validation;
  const report = runAgent({ stages, config: partial, until: "07" });
  assert.equal(report.status, "healthy-partial");
  assert.equal(report.through, "07");
  assert.equal(runAgent({ stages, config: partial }).halted.stage, "08");
});

test("the agent halts at the first unhealthy stage and checks nothing after it", () => {
  const config = reference();
  config.f5.clientSsl.minVersion = "TLSv1.0";
  config.cloudflare.ssl.mode = "flexible";
  const report = runAgent({ stages, config });
  assert.equal(report.halted.stage, "06");
  assert.deepEqual(report.halted.failing, ["HC-06-TLS"]);
  assert.ok(!report.stages.some((entry) => entry.stage === "08"), "stage 08 must not be reached");
});

// Each mutation is a realistic mistake and must trip the named check at the named stage.
const faults = [
  ["HC-01-PLAN", (c) => { delete c.addressing.panorama; }],
  ["HC-01-ADDR", (c) => { c.addressing.origin = "8.8.8.8"; }],
  ["HC-01-UNIQUE", (c) => { c.addressing.panorama = c.addressing.f5Self; }],
  ["HC-02-MGT-SOURCE", (c) => { c.management.permittedSources = ["0.0.0.0/0"]; }],
  ["HC-02-MGT-PROTO", (c) => { c.management.protocols = ["https", "telnet"]; }],
  ["HC-02-PROFILE", (c) => { c.paloalto.interfaces[0].managementProfile = { services: ["https"], permittedSources: ["10.99.0.0/24"] }; }],
  ["HC-03-ZONES", (c) => { c.paloalto.zones = c.paloalto.zones.filter((zone) => zone !== "dmz"); }],
  ["HC-03-IFACE", (c) => { c.paloalto.interfaces[1].address = "10.77.0.2/24"; }],
  ["HC-03-ROUTES", (c) => { c.paloalto.routes = c.paloalto.routes.filter((route) => route.destination !== "0.0.0.0/0"); }],
  ["HC-04-MEMBERS", (c) => { c.f5.pool.members[1].address = "10.20.0.50"; }],
  ["HC-04-MONITOR", (c) => { c.f5.pool.monitor.send = "GET /health HTTP/1.1"; }],
  ["HC-05-CERT-NAME", (c) => { c.tls.certificate.subject = "other.lab.example"; }],
  ["HC-05-CERT-EXPIRY", (c) => { c.tls.certificate.notAfter = "2026-12-01"; }],
  ["HC-05-CERT-CHAIN", (c) => { c.tls.certificate.issuer = "private-ca"; }],
  ["HC-06-VIP", (c) => { c.f5.virtualServer.destination = "10.20.0.101:443"; }],
  ["HC-06-POOL", (c) => { c.f5.virtualServer.pool = "missing-pool"; }],
  ["HC-06-TLS", (c) => { c.f5.clientSsl.minVersion = "TLSv1.1"; }],
  ["HC-06-SNAT", (c) => { c.f5.virtualServer.snat = "none"; }],
  ["HC-07-ORDER", (c) => { c.paloalto.rules.push(c.paloalto.rules.splice(2, 1)[0]); }],
  ["HC-07-NARROW", (c) => { c.paloalto.rules[1].source = "any"; }],
  ["HC-07-EDGE", (c) => { c.paloalto.rules[0].destination = "10.20.0.100"; }],
  ["HC-07-FRESH", (c) => { c.paloalto.addressObjects["cloudflare-ranges"].refreshed = "2026-06-01"; }],
  ["HC-07-NAT", (c) => { c.paloalto.nat = []; }],
  ["HC-07-BRANCH", (c) => { c.paloalto.rules[1].destination = "10.30.0.0/24"; }],
  ["HC-07-POOLPATH", (c) => { c.paloalto.rules = c.paloalto.rules.filter((rule) => rule.name !== "f5-to-pool"); }],
  ["HC-07-LOG", (c) => { c.paloalto.rules[0].log = false; }],
  ["HC-08-PROXIED", (c) => { c.cloudflare.dns.proxied = false; }],
  ["HC-08-SSLMODE", (c) => { c.cloudflare.ssl.mode = "full"; }],
  ["HC-09-WAF", (c) => { c.cloudflare.waf.tunedAt = ""; }],
  ["HC-09-ORIGIN", (c) => { c.cloudflare.authenticatedOriginPulls = false; }],
  ["HC-10-IKE", (c) => { c.meraki.nonMerakiPeer.ikeVersion = 1; }],
  ["HC-10-PEERS", (c) => { c.paloalto.ipsec.peer = "198.51.100.99"; }],
  ["HC-10-PSK", (c) => { c.meraki.nonMerakiPeer.pskRef = "secret-store://lab/other"; }],
  ["HC-10-NETS", (c) => { c.meraki.nonMerakiPeer.remoteNetworks.push("10.30.0.0/24"); }],
  ["HC-10-ZONE", (c) => { c.paloalto.ipsec.tunnelInterface = "tunnel.9"; }],
  ["HC-11-FW", (c) => { c.meraki.firewall.push({ policy: "allow", protocol: "any", destination: "10.30.0.0/24", port: "any" }); }],
  ["HC-11-RETURN", (c) => { c.paloalto.routes = c.paloalto.routes.filter((route) => route.destination !== "10.40.0.0/24"); }],
  ["HC-11-ISOLATION", (c) => { c.paloalto.rules.splice(3, 0, { name: "branch-to-pool", from: "vpn-branch", to: "app", source: "10.40.0.0/24", destination: "10.30.0.0/24", service: "tcp/8080", action: "allow", log: true }); }],
  ["HC-12-RESULTS", (c) => { c.validation.results = c.validation.results.slice(0, 3); }],
  ["HC-12-NOFAIL", (c) => { c.validation.results[0].result = "fail"; }],
  ["HC-12-ENFORCED", (c) => { c.cloudflare.waf.action = "log"; }]
];

for (const [id, mutate] of faults) {
  test(`${id} fires when its config is wrong`, () => {
    const config = reference();
    mutate(config);
    const stage = CHECKS.find((check) => check.id === id).stage;
    assert.ok(failingIds(config, stage).includes(id), `${id} did not fail`);
  });
}

test("every check has a fault case that proves it can fail", () => {
  const covered = new Set(faults.map(([id]) => id));
  for (const check of CHECKS.filter((candidate) => candidate.stage !== "00")) assert.ok(covered.has(check.id), `${check.id} has no fault case`);
});

test("HC-00-SECRET catches credential-like keys and key material, at any depth, without echoing values", () => {
  const withKey = reference();
  withKey.f5.pool.members[0].apiKey = "SYNTH-LEAK-VALUE";
  const withPem = reference();
  withPem.notes = "-----BEGIN RSA PRIVATE KEY-----SYNTH-LEAK-VALUE";
  for (const config of [withKey, withPem]) {
    const report = runAgent({ stages, config, until: "01" });
    assert.deepEqual(report.halted.failing, ["HC-00-SECRET"]);
    assert.ok(!JSON.stringify(report).includes("SYNTH-LEAK-VALUE"));
  }
});

test("a malformed section fails its check instead of crashing the agent", () => {
  const config = reference();
  config.paloalto.rules = "not-a-list";
  const report = runAgent({ stages, config });
  assert.equal(report.status, "halted");
});

test("address helpers accept lab ranges and reject near misses", () => {
  for (const ok of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "198.51.100.40/24", "203.0.113.10"]) assert.ok(isLabAddress(ok), ok);
  for (const bad of ["8.8.8.8", "172.32.0.1", "198.51.101.1", "0.0.0.0/0", "10.0.0", "256.1.1.1", ""]) assert.ok(!isLabAddress(bad), bad);
  assert.ok(within("10.99.0.5", "10.99.0.0/24"));
  assert.ok(!within("10.99.0.0/16", "10.99.0.0/24"));
});
