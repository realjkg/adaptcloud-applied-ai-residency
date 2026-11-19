import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSnapshot } from "../tools/collect/collector.mjs";
import { readOnly } from "../tools/collect/readonly-http.mjs";
import { validateSnapshot } from "../viewer/snapshot.js";

const ENV = { CLOUDFLARE_API_TOKEN: "SYNTH-CF-SECRET", BIGIP_USERNAME: "synth-u", BIGIP_PASSWORD: "SYNTH-F5-SECRET", PANOS_API_KEY: "SYNTH-PAN-SECRET", MERAKI_API_KEY: "SYNTH-MX-SECRET" };
const SETTINGS = {
  enabled: true, acknowledgesUntested: true, synthetic: true,
  vendors: {
    cloudflare: { zoneId: "a".repeat(32), recordName: "app.lab.example", hosts: ["api.cloudflare.com"] },
    f5: { host: "10.20.0.10", virtualServer: "app-vs", hosts: ["10.20.0.10"] },
    paloalto: { host: "fw.lab.example", hosts: ["fw.lab.example"] },
    meraki: { networkId: "N_1", hosts: ["api.meraki.com"] }
  }
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const entry = (name, extra = {}) => ({ "@name": name, ...extra });

function fakeFetch(calls, { failHost } = {}) {
  return async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, host: u.hostname, path: u.pathname, auth: JSON.stringify(init.headers) });
    if (u.hostname === failHost) return json({ nope: true }, 500);
    if (u.hostname === "api.cloudflare.com") {
      if (u.pathname.endsWith("/dns_records")) return json({ success: true, result: [{ name: "app.lab.example", type: "A", content: "198.51.100.2", proxied: true }] });
      return json({ success: true, result: { value: "strict" } });
    }
    if (u.hostname === "10.20.0.10") {
      if (u.pathname.endsWith("/virtual")) return json({ items: [{ name: "app-vs", destination: "/Common/10.20.0.100:443", ipProtocol: "tcp", pool: "/Common/app-pool", sourceAddressTranslation: { type: "automap" } }] });
      return json({ items: [{ name: "app-pool", loadBalancingMode: "round-robin", membersReference: { items: [{ name: "10.30.0.11:8080", address: "10.30.0.11" }] } }] });
    }
    if (u.hostname === "fw.lab.example") {
      if (u.pathname.endsWith("/Zones")) return json({ "@status": "success", result: { entry: [entry("untrust"), entry("dmz")] } });
      if (u.pathname.endsWith("/SecurityRules")) return json({ "@status": "success", result: { entry: [entry("edge-https", { from: { member: ["untrust"] }, to: { member: ["dmz"] }, source: { member: ["any"] }, destination: { member: ["198.51.100.2"] }, service: { member: ["tcp/443"] }, action: "allow" })] } });
      return json({ "@status": "success", result: { entry: [] } });
    }
    if (u.hostname === "api.meraki.com") return json({ rules: [{ comment: "web", policy: "allow", protocol: "tcp", destCidr: "10.20.0.100/32", destPort: "443" }, { comment: "Default rule", policy: "allow", protocol: "any", destCidr: "Any", destPort: "Any" }] });
    return json({}, 404);
  };
}
const run = (settings = SETTINGS, fetchImpl) => collectSnapshot({ settings, env: ENV, fetchImpl: fetchImpl ?? fakeFetch([]), now: new Date("2026-11-19T10:00:00.123Z"), snapshotId: "COLLECT-0001" });

test("the collector is refused unless enabled, acknowledged, configured, and allowlisted", async () => {
  assert.equal((await run({ ...SETTINGS, enabled: false })).refusal, "collector_disabled");
  assert.equal((await run({ ...SETTINGS, acknowledgesUntested: false })).refusal, "untested_not_acknowledged");
  assert.equal((await run({ enabled: true, acknowledgesUntested: true, vendors: {} })).refusal, "no_vendors_configured");
  assert.equal((await run({ ...SETTINGS, vendors: { f5: { host: "10.20.0.10" } } })).refusal, "host_allowlist_missing");
});

test("a collection reads every vendor with GET only and produces a valid snapshot of the observed state", async () => {
  const calls = [];
  const result = await run(SETTINGS, fakeFetch(calls));
  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter((c) => c.method !== "GET"), []);
  assert.deepEqual(validateSnapshot(result.snapshot), []);
  assert.equal(result.snapshot.source.kind, "live-collector");
  assert.deepEqual(result.snapshot.source.access.map((a) => a.vendor), ["cloudflare", "f5", "meraki", "paloalto"]);
  assert.ok(result.snapshot.source.access.every((a) => a.mode === "read-only"));
  assert.equal(result.snapshot.capturedAt, "2026-11-19T10:00:00Z");
  const labels = result.snapshot.topology.nodes.map((n) => n.lines.join(" ")).join("|");
  assert.match(labels, /app\.lab\.example/);
  assert.match(labels, /10\.20\.0\.100:443/);
  assert.match(labels, /zone dmz/);
});

test("credentials never appear in the snapshot", async () => {
  const text = JSON.stringify((await run()).snapshot);
  for (const secret of Object.values(ENV)) assert.ok(!text.includes(secret));
});

test("one failing vendor is reported and the others are still read", async () => {
  const result = await run(SETTINGS, fakeFetch([], { failHost: "fw.lab.example" }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.source.failed, [{ vendor: "paloalto", reason: "unexpected_response" }]);
  assert.ok(!result.snapshot.source.access.some((a) => a.vendor === "paloalto"));
  assert.match(result.snapshot.label, /1 failed/);
});

test("when every vendor fails nothing is produced", async () => {
  const fail = async () => json({}, 500);
  const result = await run(SETTINGS, fail);
  assert.equal(result.ok, false);
  assert.equal(result.refusal, "all_vendors_failed");
});

test("a host that is not on the vendor's allowlist is never contacted", async () => {
  const calls = [];
  const settings = structuredClone(SETTINGS);
  settings.vendors.cloudflare.hosts = ["api.other.example"];
  const result = await run(settings, fakeFetch(calls));
  assert.ok(!calls.some((c) => c.host === "api.cloudflare.com"));
  assert.deepEqual(result.snapshot.source.failed, [{ vendor: "cloudflare", reason: "host_not_allowlisted" }]);
});

test("a missing credential fails that vendor without a value in the reason", async () => {
  const result = await collectSnapshot({ settings: SETTINGS, env: { ...ENV, MERAKI_API_KEY: undefined }, fetchImpl: fakeFetch([]), now: new Date(), snapshotId: "COLLECT-0002" });
  assert.equal(result.failed[0].vendor, "meraki");
  assert.ok(!JSON.stringify(result.failed).includes("SYNTH"));
});

test("the read-only wrapper refuses every method but GET before the network", () => {
  let reached = false;
  const http = readOnly(async () => { reached = true; return {}; });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", undefined]) assert.throws(() => http({ method, url: "https://x.example/" }), /collector_is_read_only/);
  assert.equal(reached, false);
});
