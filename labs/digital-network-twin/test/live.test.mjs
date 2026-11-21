import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createCloudflareAdapter } from "../tools/live/cloudflare.mjs";
import { secretFromEnv } from "../tools/live/credentials.mjs";
import { createF5Adapter } from "../tools/live/f5.mjs";
import { createGuardedHttp, HttpRefusal } from "../tools/live/guarded-http.mjs";
import { createLiveTransport } from "../tools/live/transport.mjs";
import { digestOf as digestOfChangeset, LIVE_AUTHORIZATION_ADR } from "../tools/provision-policy.mjs";
import { apply, destroy, plan, prepare, selectChangeSet } from "../tools/provision.mjs";
import { BIGIP_PASS, BIGIP_USER, CF_TOKEN, createFakeVendors, ENV, F5_HOST, ZONE_ID } from "./fake-vendors.mjs";
import { runTransportContract } from "./transport-contract.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const reference = () => JSON.parse(readFileSync(join(root, "config", "twin-config.json"), "utf8"));
const NOW = new Date("2026-11-19T12:00:00Z");

const LIVE_POLICY = {
  enabled: true,
  environment: "lab",
  allowedTenants: ["lab-tenant-001"],
  allowedVendors: ["cloudflare", "f5"],
  transport: "live",
  maxOperations: 50,
  allowDestroy: true,
  liveAuthorization: { adr: LIVE_AUTHORIZATION_ADR, acknowledgesUntested: true },
  allowedHosts: { cloudflare: ["api.cloudflare.com"], f5: [F5_HOST] },
  live: { cloudflare: { zoneId: ZONE_ID }, f5: { host: F5_HOST } }
};
const SUBSET = ["cloudflare/dns-record", "f5/monitor", "f5/pool", "f5/pool-member", "f5/virtual-server"];

const refusalOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof HttpRefusal ? error.code : `error:${error.message}`;
  }
};

// ---- guarded HTTP ----------------------------------------------------------------------------------------------

function countingFetch(response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(url, init);
  };
  return { fetchImpl, calls };
}

test("guarded http: refuses unsafe requests before any network call", async () => {
  const { fetchImpl, calls } = countingFetch();
  const http = createGuardedHttp({ allowedHosts: ["api.example.test", "127.0.0.1", "169.254.169.254", "localhost"], fetchImpl });
  const cases = [
    [{ method: "TRACE", url: "https://api.example.test/" }, "method_not_allowed"],
    [{ method: "GET", url: "not a url" }, "url_invalid"],
    [{ method: "GET", url: "http://api.example.test/" }, "not_https"],
    [{ method: "GET", url: "https://user:pass@api.example.test/" }, "userinfo_not_permitted"],
    [{ method: "GET", url: "https://127.0.0.1/" }, "host_blocked"],
    [{ method: "GET", url: "https://2130706433/" }, "host_blocked"],
    [{ method: "GET", url: "https://localhost/" }, "host_blocked"],
    [{ method: "GET", url: "https://[::1]/" }, "host_blocked"],
    [{ method: "GET", url: "https://[::ffff:127.0.0.1]/" }, "host_blocked"],
    [{ method: "GET", url: "https://169.254.169.254/latest/meta-data/" }, "host_blocked"],
    [{ method: "GET", url: "https://metadata.google.internal/" }, "host_blocked"],
    [{ method: "GET", url: "https://anything.internal/" }, "host_blocked"],
    [{ method: "GET", url: "https://other.example.test/" }, "host_not_allowlisted"]
  ];
  for (const [request, code] of cases) assert.equal(await refusalOf(http(request)), code, request.url);
  assert.equal(calls.length, 0, "no refused request may reach fetch");
});

test("guarded http: a blocked address stays blocked even when the operator allowlists it", async () => {
  const { fetchImpl, calls } = countingFetch();
  const http = createGuardedHttp({ allowedHosts: ["127.0.0.1", "169.254.169.254", "localhost", "metadata.google.internal"], fetchImpl });
  for (const host of ["127.0.0.1", "169.254.169.254", "localhost", "metadata.google.internal"]) assert.equal(await refusalOf(http({ method: "GET", url: `https://${host}/` })), "host_blocked");
  assert.equal(calls.length, 0);
});

test("guarded http: a trailing-dot spelling is the same host, not a way around the allowlist", async () => {
  const { fetchImpl } = countingFetch();
  const http = createGuardedHttp({ allowedHosts: ["api.example.test"], fetchImpl });
  assert.equal((await http({ method: "GET", url: "https://API.example.test./x" })).status, 200);
  assert.equal(await refusalOf(createGuardedHttp({ allowedHosts: ["good.example.test"], fetchImpl })({ method: "GET", url: "https://evil.example.test./" })), "host_not_allowlisted");
  assert.equal(await refusalOf(createGuardedHttp({ allowedHosts: ["metadata.google.internal."], fetchImpl })({ method: "GET", url: "https://metadata.google.internal./" })), "host_blocked");
});

test("guarded http: wildcard allowlist entries are rejected at construction", () => {
  assert.throws(() => createGuardedHttp({ allowedHosts: ["*.example.test"], fetchImpl: globalThis.fetch }), /exact host names/);
});

test("guarded http: never follows a redirect, and passes redirect manual to fetch", async () => {
  const redirecting = countingFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }));
  const http = createGuardedHttp({ allowedHosts: ["api.example.test"], fetchImpl: redirecting.fetchImpl });
  assert.equal(await refusalOf(http({ method: "GET", url: "https://api.example.test/" })), "redirect_not_permitted");
  assert.equal(redirecting.calls.length, 1);
  assert.equal(redirecting.calls[0].init.redirect, "manual");
});

test("guarded http: refuses a wrong content type, oversize results, invalid JSON, and a hung server", async () => {
  const make = (response, extra = {}) => createGuardedHttp({ allowedHosts: ["api.example.test"], fetchImpl: countingFetch(response).fetchImpl, ...extra });
  const get = { method: "GET", url: "https://api.example.test/" };
  assert.equal(await refusalOf(make(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))(get)), "content_type_not_allowed");
  assert.equal(await refusalOf(make(() => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "99999999" } }))(get)), "result_too_large");
  assert.equal(await refusalOf(make(() => new Response("x".repeat(50), { status: 200, headers: { "content-type": "application/json" } }), { maxBytes: 10 })(get)), "result_too_large");
  assert.equal(await refusalOf(make(() => new Response("{nope", { status: 200, headers: { "content-type": "application/json" } }))(get)), "invalid_json");
  const hung = createGuardedHttp({ allowedHosts: ["api.example.test"], timeoutMs: 20, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(await refusalOf(hung(get)), "transport_error");
});

test("guarded http: builds credentials per request, and an error never contains them", async () => {
  let built = 0;
  const failing = createGuardedHttp({ allowedHosts: ["api.example.test"], fetchImpl: async () => { throw new Error(`boom ${CF_TOKEN}`); } });
  const auth = () => {
    built += 1;
    return { authorization: `Bearer ${CF_TOKEN}` };
  };
  const error = await failing({ method: "GET", url: "https://api.example.test/", auth }).catch((caught) => caught);
  assert.equal(error.code, "transport_error");
  assert.ok(!String(error.message).includes(CF_TOKEN) && !JSON.stringify(error).includes(CF_TOKEN));
  assert.equal(built, 1);
});

// ---- credentials -----------------------------------------------------------------------------------------------

test("credentials: a secret cannot reach a log, a string, or JSON, and a missing one names only the variable", () => {
  const secret = secretFromEnv({ TOKEN: "SYNTH-SECRET-VALUE" }, "TOKEN");
  for (const rendered of [String(secret), JSON.stringify({ secret }), inspect(secret), `${secret}`]) assert.ok(!rendered.includes("SYNTH-SECRET-VALUE"), rendered);
  assert.equal(secret.reveal(), "SYNTH-SECRET-VALUE");
  assert.throws(() => secretFromEnv({}, "TOKEN"), /credential_unavailable: TOKEN/);
  assert.throws(() => secretFromEnv({ TOKEN: "" }, "TOKEN"), /credential_unavailable/);
});

// ---- Cloudflare adapter ----------------------------------------------------------------------------------------

function cloudflareAdapter(options = {}, env = ENV) {
  const fake = createFakeVendors(options);
  const http = createGuardedHttp({ allowedHosts: ["api.cloudflare.com"], fetchImpl: fake.fetchImpl });
  return { fake, adapter: createCloudflareAdapter({ http, zoneId: ZONE_ID, env }) };
}
const dnsKey = { vendor: "cloudflare", object: "dns-record", name: "app.lab.example" };
const dnsAttributes = { type: "A", content: "198.51.100.2", proxied: true };

test("cloudflare: create writes an owned record, and read reports it in the engine's shape", async () => {
  const { fake, adapter } = cloudflareAdapter();
  await adapter.create(dnsKey, dnsAttributes, "SYNTH-TWIN-NET-001");
  assert.equal(fake.dns[0].comment, "twin-managed:SYNTH-TWIN-NET-001");
  assert.equal(fake.dns[0].ttl, 1);
  assert.deepEqual(await adapter.read(dnsKey), { ...dnsKey, attributes: dnsAttributes, managedBy: "SYNTH-TWIN-NET-001" });
});

test("cloudflare: only DNS records are supported, and unsafe names are refused", () => {
  const { adapter } = cloudflareAdapter();
  const op = (over) => ({ ...dnsKey, attributes: dnsAttributes, ...over });
  assert.equal(adapter.supports(op()), true);
  for (const bad of [{ object: "zone-setting" }, { object: "managed-ruleset" }, { name: "a/../b" }, { name: "x y" }, { attributes: { ...dnsAttributes, ttl: 300 } }, { attributes: { ...dnsAttributes, type: "TXT" } }, { attributes: { ...dnsAttributes, proxied: "yes" } }]) {
    assert.equal(adapter.supports(op(bad)), false, JSON.stringify(bad));
  }
  assert.throws(() => createCloudflareAdapter({ http: () => {}, zoneId: "../zones", env: ENV }), /zoneId/);
});

test("cloudflare: delete removes only records this twin owns, and leaves anyone else's", async () => {
  const { fake, adapter } = cloudflareAdapter();
  fake.seedDns({ type: "A", name: "app.lab.example", content: "203.0.113.9", proxied: false, comment: "someone else" });
  assert.deepEqual(await adapter.delete(dnsKey, "SYNTH-TWIN-NET-001"), { ok: false, reason: "unmanaged_object" });
  assert.equal(fake.dns.length, 1);
  await adapter.create(dnsKey, dnsAttributes, "SYNTH-TWIN-NET-001");
  assert.deepEqual(await adapter.delete(dnsKey, "SYNTH-TWIN-NET-001"), { ok: true, outcome: "deleted" });
  assert.deepEqual(fake.dns.map((record) => record.content), ["203.0.113.9"]);
  assert.deepEqual(await adapter.delete({ ...dnsKey, name: "gone.lab.example" }, "SYNTH-TWIN-NET-001"), { ok: true, outcome: "not_found" });
});

test("cloudflare: uses the documented name.exact filter, matches case-insensitively, and accepts the documented delete response", async () => {
  const { fake, adapter } = cloudflareAdapter();
  await adapter.create(dnsKey, dnsAttributes, "SYNTH-TWIN-NET-001");
  fake.requests.length = 0;
  assert.ok(await adapter.read({ ...dnsKey, name: "APP.lab.example" }), "a different letter case is the same DNS name");
  assert.match(fake.requests[0].search, /^\?name\.exact=APP\.lab\.example$/);
  assert.deepEqual(await adapter.delete(dnsKey, "SYNTH-TWIN-NET-001"), { ok: true, outcome: "deleted" });
  assert.equal(fake.dns.length, 0);
});

test("cloudflare: if the API ignored the name filter, another record is still never read or deleted", async () => {
  const { fake, adapter } = cloudflareAdapter({ ignoreNameFilter: true });
  const owner = "SYNTH-TWIN-NET-001";
  fake.seedDns({ type: "A", name: "other.lab.example", content: "203.0.113.50", proxied: false, comment: `twin-managed:${owner}` });
  assert.equal(await adapter.read(dnsKey), null, "a record with another name must not be reported");
  assert.deepEqual(await adapter.delete(dnsKey, owner), { ok: true, outcome: "not_found" });
  assert.equal(fake.dns.length, 1, "the other record, even one this twin owns, must survive a delete of a different name");
});

test("cloudflare: a result spread over several pages stops the run instead of acting on a partial view", async () => {
  const { adapter } = cloudflareAdapter({ dnsPages: 2 });
  await assert.rejects(() => adapter.read(dnsKey), /cloudflare read incomplete/);
  await assert.rejects(() => adapter.delete(dnsKey, "SYNTH-TWIN-NET-001"), /cloudflare read incomplete/);
});

test("cloudflare: a delete that does not return the deleted record id is treated as a failure", async () => {
  const { fake, adapter } = cloudflareAdapter();
  await adapter.create(dnsKey, dnsAttributes, "SYNTH-TWIN-NET-001");
  const original = fake.fetchImpl;
  const wrapped = async (href, init) => (init?.method === "DELETE" ? new Response(JSON.stringify({ result: { id: "ffffffffffffffffffffffffffffffff" } }), { status: 200, headers: { "content-type": "application/json" } }) : original(href, init));
  const http = createGuardedHttp({ allowedHosts: ["api.cloudflare.com"], fetchImpl: wrapped });
  await assert.rejects(() => createCloudflareAdapter({ http, zoneId: ZONE_ID, env: ENV }).delete(dnsKey, "SYNTH-TWIN-NET-001"), /cloudflare delete failed/);
});

test("cloudflare: a record owned by a different twin is a conflict, not ours", async () => {
  const { adapter, fake } = cloudflareAdapter();
  fake.seedDns({ type: "A", name: "app.lab.example", content: "198.51.100.2", proxied: true, comment: "twin-managed:OTHER-TWIN" });
  assert.equal((await adapter.read(dnsKey)).managedBy, "OTHER-TWIN");
  assert.deepEqual(await adapter.delete(dnsKey, "SYNTH-TWIN-NET-001"), { ok: false, reason: "unmanaged_object" });
});

test("cloudflare: requests stay on the API host and zone, carry the token, and never follow redirects", async () => {
  const { fake, adapter } = cloudflareAdapter();
  await adapter.create(dnsKey, dnsAttributes, "SYNTH-TWIN-NET-001");
  await adapter.read(dnsKey);
  await adapter.delete(dnsKey, "SYNTH-TWIN-NET-001");
  assert.ok(fake.requests.length >= 3);
  for (const request of fake.requests) {
    assert.equal(request.host, "api.cloudflare.com");
    assert.ok(request.path.startsWith(`/client/v4/zones/${ZONE_ID}/dns_records`));
    assert.equal(request.headers.authorization, `Bearer ${CF_TOKEN}`);
    assert.equal(request.redirect, "manual");
  }
});

test("cloudflare: a missing token fails by name only, and a failed API call is an error, not a guess", async () => {
  const { adapter } = cloudflareAdapter({}, {});
  const error = await adapter.read(dnsKey).catch((caught) => caught);
  assert.match(error.message, /credential_unavailable: CLOUDFLARE_API_TOKEN/);
  const { adapter: broken } = cloudflareAdapter({ failReads: true });
  await assert.rejects(() => broken.read(dnsKey), /cloudflare read failed/);
});

// ---- F5 adapter ------------------------------------------------------------------------------------------------

function f5Adapter(options = {}, env = ENV) {
  const fake = createFakeVendors(options);
  const http = createGuardedHttp({ allowedHosts: [F5_HOST], fetchImpl: fake.fetchImpl });
  return { fake, adapter: createF5Adapter({ http, host: F5_HOST, env }) };
}
const SEND = "GET /health HTTP/1.1\r\nHost: app.lab.example\r\nConnection: close\r\n\r\n";
const f5Fixtures = {
  pool: { key: { vendor: "f5", object: "pool", name: "contract-pool" }, attributes: { method: "round-robin" } },
  monitor: { key: { vendor: "f5", object: "monitor", name: "contract-pool-monitor" }, attributes: { type: "http", send: SEND, receive: "200" } },
  member: { key: { vendor: "f5", object: "pool-member", name: "10.30.0.99:8080" }, attributes: { pool: "contract-pool" } }
};

runTransportContract("live transport (F5, against the fake)", () => {
  const { fake } = f5Adapter();
  const transport = createLiveTransport({ policy: LIVE_POLICY, env: ENV, fetchImpl: fake.fetchImpl });
  return {
    transport,
    seedUnmanaged: (key, attributes) => {
      if (key.object === "pool") fake.seedF5("pool", { name: key.name, loadBalancingMode: attributes.method, description: "not ours" });
      else throw new Error("unexpected seed");
    }
  };
}, f5Fixtures);

test("f5: each object kind is created with an ownership mark and read back in the engine's shape", async () => {
  const { fake, adapter } = f5Adapter();
  const owner = "SYNTH-TWIN-NET-001";
  const monitor = f5Fixtures.monitor;
  const pool = f5Fixtures.pool;
  const member = f5Fixtures.member;
  const vs = { key: { vendor: "f5", object: "virtual-server", name: "app-vs" }, attributes: { destination: "10.20.0.100:443", pool: "contract-pool", clientSslProfile: "app-clientssl", snat: "automap" } };
  for (const item of [monitor, pool, member, vs]) await adapter.create(item.key, item.attributes, owner);
  for (const item of [monitor, pool, member, vs]) {
    const read = await adapter.read(item.key, item.attributes);
    assert.deepEqual(read.attributes, item.attributes, item.key.object);
    assert.equal(read.managedBy, owner);
  }
  assert.equal(fake.f5.pool.get("contract-pool").monitor, "/Common/contract-pool-monitor");
  assert.equal(fake.f5.virtual.get("app-vs").sourceAddressTranslation.type, "automap");
  assert.deepEqual(fake.f5.virtual.get("app-vs").profiles.map((profile) => profile.context), ["all", "clientside"]);
});

test("f5: read-back tolerates a device that returns the monitor send string with escaped CR and LF", async () => {
  const { adapter } = f5Adapter({ escapeSend: true });
  await adapter.create(f5Fixtures.monitor.key, f5Fixtures.monitor.attributes, "SYNTH-TWIN-NET-001");
  assert.deepEqual((await adapter.read(f5Fixtures.monitor.key, f5Fixtures.monitor.attributes)).attributes, f5Fixtures.monitor.attributes);
});

test("f5: supports only what it can write faithfully, and refuses names that could alter a path", () => {
  const { adapter } = f5Adapter();
  const op = (object, name, attributes) => ({ vendor: "f5", object, name, attributes });
  assert.equal(adapter.supports(op("pool", "app-pool", { method: "round-robin" })), true);
  assert.equal(adapter.supports(op("ssl-certificate", "app-cert", { subject: "x" })), false);
  assert.equal(adapter.supports(op("client-ssl-profile", "app-clientssl", { certificate: "x", minVersion: "TLSv1.2" })), false);
  assert.equal(adapter.supports(op("pool", "../mgmt/tm/sys", { method: "round-robin" })), false);
  assert.equal(adapter.supports(op("pool", "a/b", { method: "round-robin" })), false);
  assert.equal(adapter.supports(op("pool", "app-pool", { method: "least-connections" })), false);
  assert.equal(adapter.supports(op("pool", "app-pool", { method: "round-robin", extra: 1 })), false);
  assert.equal(adapter.supports(op("pool-member", "10.30.0.11:8080", { pool: "app/pool" })), false);
  assert.equal(adapter.supports(op("pool-member", "not-an-address", { pool: "app-pool" })), false);
  assert.equal(adapter.supports(op("virtual-server", "app-vs", { destination: "10.20.0.100:443", pool: "p", clientSslProfile: "c", snat: "none" })), false);
  assert.throws(() => createF5Adapter({ http: () => {}, host: "bigip/../x", env: ENV }), /host/);
});

test("adapters refuse to create without a valid owner, so a mark can never read twin-managed:undefined", async () => {
  const cf = cloudflareAdapter();
  const f5 = f5Adapter();
  for (const owner of [undefined, null, "", "a b", "../x", 42]) {
    await assert.rejects(() => cf.adapter.create(dnsKey, dnsAttributes, owner), /invalid owner/, String(owner));
    await assert.rejects(() => f5.adapter.create(f5Fixtures.pool.key, f5Fixtures.pool.attributes, owner), /invalid owner/, String(owner));
  }
  assert.equal(cf.fake.writes() + f5.fake.writes(), 0);
});

test("f5: a pool member read without its pool is an error, not a guess", async () => {
  const { adapter } = f5Adapter();
  await assert.rejects(() => adapter.read(f5Fixtures.member.key, undefined), /pool member needs its pool/);
});

test("f5: requests use basic auth from the environment, stay on the allowlisted host, and never follow redirects", async () => {
  const { fake, adapter } = f5Adapter();
  await adapter.create(f5Fixtures.monitor.key, f5Fixtures.monitor.attributes, "SYNTH-TWIN-NET-001");
  const expected = `Basic ${Buffer.from(`${BIGIP_USER}:${BIGIP_PASS}`).toString("base64")}`;
  for (const request of fake.requests) {
    assert.equal(request.host, F5_HOST);
    assert.equal(request.headers.authorization, expected);
    assert.equal(request.redirect, "manual");
    assert.ok(request.path.startsWith("/mgmt/tm/ltm/"));
  }
  const missing = f5Adapter({}, { BIGIP_USERNAME: "u" });
  await assert.rejects(() => missing.adapter.read(f5Fixtures.monitor.key, f5Fixtures.monitor.attributes), /credential_unavailable: BIGIP_PASSWORD/);
});

// ---- engine over the live transport ----------------------------------------------------------------------------

function liveEngine({ vendorOptions = {}, policy = {}, env = ENV, config = reference() } = {}) {
  const prepared = prepare(config);
  const changeset = selectChangeSet(prepared.changeset, SUBSET);
  const fake = createFakeVendors(vendorOptions);
  const merged = { ...LIVE_POLICY, ...policy };
  const transport = createLiveTransport({ policy: merged, env, fetchImpl: fake.fetchImpl });
  const target = { environment: "lab", tenantId: "lab-tenant-001", owner: config.twinId };
  return { prepared, changeset, fake, transport, target, base: { changeset, transport, policy: merged, target } };
}

const approval = (action, changeset) => ({ ref: `TICKET-${action}-0001`, approver: "a.person", action, tenantId: "lab-tenant-001", digest: digestOfChangeset(changeset), approvedAt: NOW.toISOString() });

test("live engine: apply then destroy leaves the fake vendors exactly as they started, and spares what is not ours", async () => {
  const { fake, base, changeset } = liveEngine();
  fake.seedDns({ type: "A", name: "other.lab.example", content: "203.0.113.50", proxied: false, comment: "not ours" });
  fake.seedF5("pool", { name: "legacy-pool", loadBalancingMode: "round-robin", description: "not ours" });
  const seed = fake.snapshot();

  const planned = await plan(base);
  assert.equal(planned.ok, true);
  assert.equal(planned.summary.create, changeset.length);
  const applied = await apply({ ...base, approval: approval("apply", changeset), plannedDigest: planned.digest, now: NOW });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.created, changeset.length);
  assert.equal(fake.dns.length, 2);
  assert.equal(fake.f5.virtual.size, 1);
  assert.equal(fake.f5.members.size, 2);

  const again = await apply({ ...base, approval: approval("apply", changeset), plannedDigest: planned.digest, now: NOW });
  assert.deepEqual([again.ok, again.created, again.unchanged], [true, 0, changeset.length], "a second apply changes nothing");

  const destroyed = await destroy({ ...base, approval: approval("destroy", changeset), now: NOW });
  assert.equal(destroyed.ok, true, JSON.stringify(destroyed));
  assert.equal(fake.snapshot(), seed, "the vendors must be back to their starting state");
});

test("live engine: the whole twin is refused as unsupported before anything is read or written", async () => {
  const { prepared, fake, transport, target } = liveEngine();
  const base = { changeset: prepared.changeset, transport, policy: { ...LIVE_POLICY, allowedVendors: ["cloudflare", "f5", "paloalto", "meraki"], allowedHosts: { ...LIVE_POLICY.allowedHosts, paloalto: ["fw.lab.example"], meraki: ["api.meraki.com"] } }, target };
  const planned = await plan(base);
  assert.equal(planned.refusal, "object_unsupported");
  assert.match(planned.detail, /paloalto\/security-rule: not implemented/);
  assert.match(planned.detail, /meraki\/non-meraki-vpn-peer: not implemented/);
  assert.match(planned.detail, /cloudflare\/zone-setting/);
  assert.match(planned.detail, /f5\/ssl-certificate/);
  const applied = await apply({ ...base, approval: approval("apply", prepared.changeset), plannedDigest: "x", now: NOW });
  assert.equal(applied.refusal, "object_unsupported");
  assert.equal((await destroy({ ...base, approval: approval("destroy", prepared.changeset), now: NOW })).refusal, "object_unsupported");
  assert.equal(fake.requests.length, 0, "no request may be made");
});

test("live engine: a failure part-way rolls back, and the vendors return to their starting state", async () => {
  const { fake, base, changeset } = liveEngine({ vendorOptions: { failPostOn: ["virtual"] } });
  fake.seedF5("pool", { name: "legacy-pool", loadBalancingMode: "round-robin", description: "not ours" });
  const seed = fake.snapshot();
  const planned = await plan(base);
  const result = await apply({ ...base, approval: approval("apply", changeset), plannedDigest: planned.digest, now: NOW });
  assert.equal(result.refusal, "operation_failed");
  assert.equal(result.rolledBack.complete, true);
  assert.equal(fake.snapshot(), seed);
});

test("live engine: a write that reads back wrong halts the run and rolls back", async () => {
  const { fake, base, changeset } = liveEngine({ vendorOptions: { corruptVirtual: true } });
  const planned = await plan(base);
  const result = await apply({ ...base, approval: approval("apply", changeset), plannedDigest: planned.digest, now: NOW });
  assert.equal(result.refusal, "verification_failed");
  assert.equal(result.rolledBack.complete, true);
  assert.equal(fake.dns.length, 0);
  assert.equal(fake.f5.pool.size + fake.f5.monitor.size + fake.f5.virtual.size, 0);
});

test("live engine: an unreadable vendor stops the run before any write", async () => {
  const { fake, base } = liveEngine({ vendorOptions: { failReads: true } });
  const planned = await plan(base);
  assert.equal(planned.refusal, "operation_failed");
  assert.equal(planned.detail, "could not read current state");
  assert.equal(fake.writes(), 0);
});

test("live engine: missing credentials stop the run before any write, and no secret appears in any output", async () => {
  const { fake, base, changeset } = liveEngine({ env: { CLOUDFLARE_API_TOKEN: CF_TOKEN } });
  const planned = await plan(base);
  assert.equal(planned.refusal, "operation_failed");
  assert.equal(fake.writes(), 0);
  const full = liveEngine();
  const ok = await plan(full.base);
  const applied = await apply({ ...full.base, approval: approval("apply", changeset), plannedDigest: ok.digest, now: NOW });
  const destroyed = await destroy({ ...full.base, approval: approval("destroy", changeset), now: NOW });
  for (const output of [planned, ok, applied, destroyed]) {
    const text = JSON.stringify(output);
    assert.ok(!text.includes(CF_TOKEN) && !text.includes(BIGIP_PASS) && !text.includes(BIGIP_USER), "a credential leaked into an output");
  }
});

test("live engine: a loopback or metadata host in policy is refused by the HTTP guard and never contacted", async () => {
  for (const host of ["127.0.0.1", "169.254.169.254"]) {
    const { fake, base } = liveEngine({ policy: { allowedHosts: { cloudflare: ["api.cloudflare.com"], f5: [host] }, live: { cloudflare: { zoneId: ZONE_ID }, f5: { host } } } });
    const planned = await plan(base);
    assert.equal(planned.refusal, "operation_failed", host);
    assert.equal(fake.requests.length, 0);
  }
});

test("selectChangeSet: exact selectors only, no wildcards, nothing unmatched, and a subset has its own digest", () => {
  const { changeset } = prepare(reference());
  const subset = selectChangeSet(changeset, ["cloudflare/dns-record"]);
  assert.equal(subset.length, 1);
  assert.equal(subset[0].order, changeset.find((op) => op.object === "dns-record").order, "original order numbers are kept");
  assert.notEqual(digestOfChangeset(subset), digestOfChangeset(changeset));
  assert.throws(() => selectChangeSet(changeset, ["*/*"]), /exact/);
  assert.throws(() => selectChangeSet(changeset, ["f5/*"]), /exact/);
  assert.throws(() => selectChangeSet(changeset, []), /exact/);
  assert.throws(() => selectChangeSet(changeset, ["f5/does-not-exist"]), /matches nothing/);
});
