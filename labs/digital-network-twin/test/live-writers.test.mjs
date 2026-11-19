import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardedHttp } from "../tools/live/guarded-http.mjs";
import { createOperations } from "../server/operations.mjs";
import { createAudit } from "../server/audit.mjs";
import { createPaloAltoAdapter } from "../server/adapters/paloalto.mjs";
import { createMerakiAdapter } from "../server/adapters/meraki.mjs";
import { loadTargets } from "../server/targets.mjs";

const OP = { subject: "u-op", name: "Op", roles: ["operator"] };
const AP = { subject: "u-ap", name: "Ap", roles: ["approver"] };
const ENV = { PANOS_KEY_LAB: "SYNTH-PAN-KEY", MERAKI_KEY_LAB: "SYNTH-MX-KEY" };
const PAN_T = { id: "lab-fw-1", label: "Lab FW", vendor: "paloalto", environment: "lab", disposable: true, host: "fw.lab.example", vsys: "vsys1", deviceName: "localhost.localdomain", commitAdmin: "twin-api", credentialEnv: "PANOS_KEY_LAB", changeTypes: ["address-object.create", "address-object.delete"] };
const MX_T = { id: "lab-mx-1", label: "Lab MX", vendor: "meraki", environment: "lab", disposable: true, host: "n1.meraki.example", networkId: "N_1", credentialEnv: "MERAKI_KEY_LAB", changeTypes: ["l3-firewall-rule.add", "l3-firewall-rule.remove"] };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const xml = (b, status = 200) => new Response(b, { status, headers: { "content-type": "application/xml" } });

// ---- fake PAN-OS: a candidate config, a running config, pending changes, and commit jobs
function fakePan({ jobPolls = 1, jobResult = "OK", pending = [], loseRestReply = false, loseCommitReply = false, foreignAfterPost = false } = {}) {
  const f = { candidate: new Map(), running: new Map(), pending: [...pending], calls: [], jobs: new Map(), commitCmd: null, urls: [], keyInUrl: false };
  f.fetch = async (url, init) => {
    const u = new URL(url);
    f.calls.push(`${init.method} ${u.pathname}`);
    f.urls.push(url);
    if (init.headers["x-pan-key"] !== ENV.PANOS_KEY_LAB) return json({}, 403);
    if (u.pathname.startsWith("/restapi/")) {
      const name = u.searchParams.get("name");
      if (init.method === "GET") { const e = f.candidate.get(name); return json({ "@status": "success", result: { "@total-count": e ? 1 : 0, entry: e ? [{ "@name": name, "ip-netmask": e.ip, description: e.desc }] : [] } }); }
      if (init.method === "POST") { const b = JSON.parse(init.body).entry; f.candidate.set(name, { ip: b["ip-netmask"], desc: b.description }); f.pending.push(`/config/devices/entry[@name='localhost.localdomain']/vsys/entry[@name='vsys1']/address/entry[@name='${name}']`); if (foreignAfterPost) f.pending.push("/config/devices/entry/vsys/entry/rulebase/security/rules/entry[@name='someone-elses-rule']"); if (loseRestReply) throw new TypeError("socket hang up"); return json({ "@status": "success" }); }
      if (init.method === "DELETE") { f.candidate.delete(name); f.pending.push(`/config/.../entry[@name='${name}']`); return json({ "@status": "success" }); }
    }
    if (u.pathname === "/api/") {
      const p = u.searchParams;
      if (p.get("type") === "op" && p.get("cmd").includes("<changes/>")) return xml(`<response status="success"><result><changes>${f.pending.map((m) => `<member>${m}</member>`).join("")}</changes></result></response>`);
      if (p.get("type") === "commit") { f.commitCmd = p.get("cmd"); f.jobs.set("77", 0); f.running = new Map(f.candidate); f.pending = []; if (loseCommitReply) throw new TypeError("socket hang up"); return xml(`<response status="success" code="19"><result><msg><line>Commit job enqueued with jobid 77</line></msg><job>77</job></result></response>`); }
      if (p.get("type") === "op" && p.get("cmd").includes("<jobs>")) { const n = f.jobs.get("77") + 1; f.jobs.set("77", n); return n < jobPolls ? xml(`<response status="success"><result><job><status>ACT</status><result>PEND</result></job></result></response>`) : xml(`<response status="success"><result><job><status>FIN</status><result>${jobResult}</result></job></result></response>`); }
      if (p.get("type") === "config" && p.get("action") === "show") {
        const name = /address\/entry\[@name='([^']+)'\]/.exec(p.get("xpath"))?.[1];
        const e = f.running.get(name);
        return xml(e ? `<response status="success"><result total-count="1" count="1"><entry name="${name}"><ip-netmask>${e.ip}</ip-netmask><description>${e.desc}</description></entry></result></response>` : `<response status="success"><result total-count="0" count="0"/></response>`);
      }
    }
    return json({}, 404);
  };
  return f;
}

function panOps(f, over = {}) {
  const http = createGuardedHttp({ allowedHosts: ["fw.lab.example"], fetchImpl: f.fetch });
  const adapter = createPaloAltoAdapter({ http, target: PAN_T, env: ENV, sleep: async () => {}, pollMs: 0, maxPolls: 5, ...over });
  const dir = mkdtempSync(join(tmpdir(), "twin-lw-"));
  return createOperations({ targets: new Map([[PAN_T.id, PAN_T]]), adapters: { paloalto: adapter }, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "live", liveAuthorized: () => true });
}
const run = async (ops, req, exclusive = false) => {
  const r = await ops.request(OP, req);
  assert.equal(r.ok, true, JSON.stringify(r));
  await ops.decide(AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: exclusive });
  return { id: r.operation.id, plan: r.operation, done: await ops.execute(OP, r.operation.id) };
};
const ADDR = { name: "web-servers", ipNetmask: "10.30.0.0/24", description: "lab" };

test("Palo Alto live: candidate edit by REST, partial commit by the API admin, job polled to completion, running config read back", async () => {
  const f = fakePan({ jobPolls: 3 });
  const { done } = await run(panOps(f), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.operation.result.jobId, "77");
  assert.equal(f.commitCmd, "<commit><partial><admin><member>twin-api</member></admin></partial></commit>");
  assert.ok(f.calls.filter((c) => c.includes("/api/")).length >= 6, "polled and read back");
  assert.equal(f.running.size, 1);
  assert.ok(f.urls.every((u) => !u.includes("SYNTH-PAN-KEY")), "the key is a header, never in a URL");
});

test("Palo Alto live: an enqueued commit job is not success", async () => {
  const stuck = fakePan({ jobPolls: 99 });
  const r1 = await run(panOps(stuck), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(r1.done.operation.status, "uncertain");
  assert.equal(r1.done.operation.result.reason, "commit_job_not_finished");
  const failed = fakePan({ jobResult: "FAIL" });
  const r2 = await run(panOps(failed), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(r2.done.operation.status, "failed");
  assert.equal(r2.done.operation.result.candidateLeftInPlace, true);
});

test("Palo Alto live: refuses to plan with pending candidate changes, and refuses to commit if a foreign change appears", async () => {
  const dirty = fakePan({ pending: ["/config/x/entry[@name='other']"] });
  assert.deepEqual((await panOps(dirty).request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR })).blockers, ["pending_candidate_changes_exist"]);
  const f = fakePan({ foreignAfterPost: true });
  const ops = panOps(f);
  const r = await ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  await ops.decide(AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest });
  const done = await ops.execute(OP, r.operation.id);
  // The extra pending entry makes the candidate differ from both the baseline and the plan, so the run stops as uncertain.
  assert.equal(done.operation.status, "uncertain");
  assert.equal(done.operation.result.stage, "candidate");
  assert.equal(done.operation.result.candidateLeftInPlace, true);
  assert.equal(f.commitCmd, null, "no commit was sent");
});

test("Palo Alto live: a lost REST reply is verified by reading, not retried blindly", async () => {
  const f = fakePan({ loseRestReply: true });
  const { done } = await run(panOps(f), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(done.ok, true);
  assert.equal(f.calls.filter((c) => c.startsWith("POST")).length, 1);
});

test("Palo Alto live: a lost commit reply checks the running config and does not queue a second commit", async () => {
  const f = fakePan({ loseCommitReply: true });
  const { done } = await run(panOps(f), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(done.operation.result.note, "commit_response_lost_running_verified");
  assert.equal(f.calls.filter((c) => c === "GET /api/").length > 0, true);
});

test("Palo Alto live: only the exact host is contacted, and a wrong host is refused before anything is sent", async () => {
  const f = fakePan();
  const http = createGuardedHttp({ allowedHosts: ["other.example"], fetchImpl: f.fetch });
  const adapter = createPaloAltoAdapter({ http, target: PAN_T, env: ENV });
  const ops = createOperations({ targets: new Map([[PAN_T.id, PAN_T]]), adapters: { paloalto: adapter }, audit: createAudit({ file: join(mkdtempSync(join(tmpdir(), "x-")), "a") }), transportKind: "live" });
  const r = await ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(r.code, "plan_failed");
  assert.equal(f.calls.length, 0);
});

// ---- fake Meraki
function fakeMeraki({ rules = [], extraKey = false, loseReply = false, editDuringWrite = false } = {}) {
  const f = { rules: [...rules], puts: [], gets: 0 };
  const view = () => [...f.rules.map((r) => (extraKey ? { ...r, vpnPolicy: "x" } : r)), { comment: "Default rule", policy: "allow", protocol: "any", srcPort: "Any", srcCidr: "Any", destPort: "Any", destCidr: "Any", syslogEnabled: false }];
  f.fetch = async (url, init) => {
    if (init.headers.authorization !== `Bearer ${ENV.MERAKI_KEY_LAB}`) return json({ errors: ["Invalid API key"] }, 404);
    if (init.method === "GET") { f.gets += 1; return json({ rules: view() }); }
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      f.puts.push(body);
      f.rules = body.rules;
      if (editDuringWrite) f.rules = [...body.rules, { comment: "intruder", policy: "allow", protocol: "any", srcPort: "any", srcCidr: "any", destPort: "any", destCidr: "any", syslogEnabled: false }];
      if (loseReply) throw new TypeError("socket hang up");
      return json({ rules: view() });
    }
    return json({}, 405);
  };
  return f;
}
function mxOps(f) {
  const http = createGuardedHttp({ allowedHosts: ["n1.meraki.example"], fetchImpl: f.fetch });
  const adapter = createMerakiAdapter({ http, target: MX_T, env: ENV });
  const dir = mkdtempSync(join(tmpdir(), "twin-lw-"));
  return createOperations({ targets: new Map([[MX_T.id, MX_T]]), adapters: { meraki: adapter }, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "live" });
}
const RULE = { policy: "allow", protocol: "tcp", srcCidr: "10.40.0.0/24", srcPort: "any", destCidr: "10.20.0.100/32", destPort: "443", comment: "branch web" };
const KEEP = { comment: "keep", policy: "deny", protocol: "any", srcPort: "any", srcCidr: "any", destPort: "any", destCidr: "10.0.0.0/8", syslogEnabled: false };

test("Meraki live: the PUT carries the unrelated rules unchanged, in order, without the default rule, and the list is read back", async () => {
  const f = fakeMeraki({ rules: [KEEP] });
  const { done } = await run(mxOps(f), { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE }, true);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(f.puts.length, 1);
  assert.deepEqual(f.puts[0].rules[0], KEEP);
  assert.equal(f.puts[0].rules.length, 2);
  assert.ok(!f.puts[0].rules.some((r) => r.comment === "Default rule"));
});

test("Meraki live: refuses a list it cannot round-trip, and never writes", async () => {
  const f = fakeMeraki({ rules: [KEEP], extraKey: true });
  const r = await mxOps(f).request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  assert.equal(r.code, "plan_failed");
  assert.equal(r.detail, "list_not_round_trippable");
  assert.equal(f.puts.length, 0);
});

test("Meraki live: a lost reply is verified by reading and not written twice; a bad key is reported as not found, not as success", async () => {
  const f = fakeMeraki({ rules: [KEEP], loseReply: true });
  const { done } = await run(mxOps(f), { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE }, true);
  assert.equal(done.operation.result.note, "write_response_lost_state_verified");
  assert.equal(f.puts.length, 1);
  const badKey = mxOps({ ...fakeMeraki(), fetch: async () => json({ errors: ["x"] }, 404) });
  assert.equal((await badKey.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE })).detail, "network_not_found_or_key_rejected");
});

test("Meraki live: an edit made during the write is reported as uncertain with no repair", async () => {
  const f = fakeMeraki({ rules: [KEEP], editDuringWrite: true });
  const { done } = await run(mxOps(f), { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE }, true);
  assert.equal(done.operation.status, "uncertain");
  assert.equal(f.puts.length, 1, "no second write to 'fix' it");
});

test("target settings: live targets must be disposable lab targets with exact hosts and only change types the live adapter implements", () => {
  assert.deepEqual(loadTargets([PAN_T, MX_T], { live: true }).problems, []);
  const bad = loadTargets([{ ...PAN_T, environment: "production" }, { ...MX_T, id: "m2", host: "*.meraki.com", changeTypes: ["sdwan.uplink-preference.set"] }, { ...PAN_T, id: "p3", disposable: false, credentialEnv: "lower" }], { live: true }).problems.join(" | ");
  assert.match(bad, /disposable lab target/);
  assert.match(bad, /exact host/);
  assert.match(bad, /no live adapter/);
  assert.match(bad, /credentialEnv/);
  assert.equal(loadTargets([{ id: "s", vendor: "meraki", label: "Sim", changeTypes: ["sdwan.uplink-preference.set"] }], { live: false }).problems.length, 0);
});
