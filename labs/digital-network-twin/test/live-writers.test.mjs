import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync as _readFileSync, writeFileSync as _writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardedHttp } from "../tools/live/guarded-http.mjs";
import { createOperations } from "../server/operations.mjs";
import { createAudit } from "../server/audit.mjs";
import { createCommitJournal } from "../server/commit-journal.mjs";
import { createPaloAltoAdapter } from "../server/adapters/paloalto.mjs";
import { createMerakiAdapter } from "../server/adapters/meraki.mjs";
import { loadTargets } from "../server/targets.mjs";
import { SIMULATOR_TARGETS } from "../server/simulator-targets.mjs";
import { createLivePolicy, createTargetResolver } from "../server/target-resolution.mjs";

const OP = { subject: "u-op", name: "Op", roles: ["operator"], labId: "live" };
const AP = { subject: "u-ap", name: "Ap", roles: ["approver"], labId: "live" };
const ENV = { PANOS_KEY_LAB: "SYNTH-PAN-KEY", MERAKI_KEY_LAB: "SYNTH-MX-KEY" };
const PAN_T = { id: "lab-fw-1", label: "Lab FW", vendor: "paloalto", environment: "lab", disposable: true, host: "fw.lab.corp.test", firewallSerial: "007054000123456", access: { principals: ["u-op", "u-ap"] }, vsys: "vsys1", deviceName: "localhost.localdomain", commitAdmin: "twin-api", credentialEnv: "PANOS_KEY_LAB", changeTypes: ["address-object.create", "address-object.delete"] };
const MX_T = { id: "lab-mx-1", label: "Lab MX", vendor: "meraki", environment: "lab", disposable: true, host: "n1.meraki.corp.test", organizationId: "555001", applianceSerial: "Q2XX-ABCD-1234", access: { principals: ["u-op", "u-ap"] }, networkId: "N_1", credentialEnv: "MERAKI_KEY_LAB", changeTypes: ["l3-firewall-rule.add", "l3-firewall-rule.remove"] };
const liveOps = (target, adapter) => createOperations({
  resolver: createTargetResolver({ mode: "live", targets: new Map([[target.id, target]]), fixtures: SIMULATOR_TARGETS }),
  policy: createLivePolicy({ [target.id]: target.access.principals }),
  adapters: { [target.vendor]: adapter },
  audit: createAudit({ file: join(mkdtempSync(join(tmpdir(), "twin-lw-")), "a.jsonl") }), transportKind: "live", liveAuthorized: () => true
});
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const xml = (b, status = 200) => new Response(b, { status, headers: { "content-type": "application/xml" } });

// ---- fake PAN-OS: a candidate config, a running config, pending changes, and commit jobs
function fakePan({ jobPolls = 1, jobResult = "OK", pending = [], loseRestReply = false, loseCommitReply = false, foreignAfterPost = false, commitNoChanges = false, garbleCommitReply = false, wrongJobId = false, firstPoll = null } = {}) {
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
      if (p.get("type") === "op" && p.get("cmd").includes("<system>")) return xml(`<response status="success"><result><system><serial>${f.serial ?? "007054000123456"}</serial></system></result></response>`);
      if (p.get("type") === "op" && p.get("cmd").includes("<changes/>")) return xml(`<response status="success"><result><changes>${f.pending.map((m) => `<member>${m}</member>`).join("")}</changes></result></response>`);
      if (p.get("type") === "commit") {
        f.commits = (f.commits ?? 0) + 1;
        if (p.get("action") !== "partial" || !p.get("cmd").includes("<device-and-network>excluded</device-and-network><shared-object>excluded</shared-object><admin><member>twin-api</member></admin>")) return xml(`<response status="error" code="12"><msg>bad commit request</msg></response>`);
        f.commitCmd = p.get("cmd");
        if (garbleCommitReply) { f.running = new Map(f.candidate); f.pending = []; return xml("<html>gateway</html>"); }
        if (commitNoChanges) { f.running = new Map(f.candidate); f.pending = []; return xml(`<response status="success" code="19"><msg>There are no changes to commit.</msg></response>`); } f.jobs.set("77", 0); f.running = new Map(f.candidate); f.pending = []; if (loseCommitReply) throw new TypeError("socket hang up"); return xml(`<response status="success" code="19"><result><msg><line>Commit job enqueued with jobid 77</line></msg><job>77</job></result></response>`); }
      if (p.get("type") === "op" && p.get("cmd").includes("<jobs>")) { if (firstPoll && f.jobs.get("77") === 0) firstPoll(); const n = f.jobs.get("77") + 1; f.jobs.set("77", n); const pollsNeeded = f.finishJobs ? 0 : jobPolls; if (wrongJobId) return xml(`<response status="success"><result><job><id>999</id><status>FIN</status><result>OK</result></job></result></response>`); return n < pollsNeeded ? xml(`<response status="success"><result><job><id>77</id><status>ACT</status><result>PEND</result></job></result></response>`) : xml(`<response status="success"><result><job><id>77</id><status>FIN</status><result>${jobResult}</result></job></result></response>`); }
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
  const http = createGuardedHttp({ allowedHosts: ["fw.lab.corp.test"], fetchImpl: f.fetch });
  return liveOps(PAN_T, createPaloAltoAdapter({ http, target: PAN_T, env: ENV, sleep: async () => {}, pollMs: 0, maxPolls: 5, ...over }));
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
  assert.equal(f.commitCmd, "<commit><partial><device-and-network>excluded</device-and-network><shared-object>excluded</shared-object><admin><member>twin-api</member></admin></partial></commit>");
  assert.ok(f.urls.some((u) => u.includes("type=commit") && u.includes("action=partial")));
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
  const ops = liveOps(PAN_T, adapter);
  const r = await ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(r.code, "scope_mismatch");
  assert.equal(r.detail, "host_not_allowlisted");
  assert.equal(f.calls.length, 0);
});

// ---- fake Meraki
function fakeMeraki({ rules = [], extraKey = false, loseReply = false, editDuringWrite = false } = {}) {
  const f = { rules: [...rules], puts: [], gets: 0 };
  const view = () => [...f.rules.map((r) => (extraKey ? { ...r, vpnPolicy: "x" } : r)), { comment: "Default rule", policy: "allow", protocol: "any", srcPort: "Any", srcCidr: "Any", destPort: "Any", destCidr: "Any", syslogEnabled: false }];
  f.fetch = async (url, init) => {
    if (init.headers.authorization !== `Bearer ${ENV.MERAKI_KEY_LAB}`) return json({ errors: ["Invalid API key"] }, 404);
    if (init.method === "GET") {
      const path = new URL(url).pathname;
      if (path.endsWith("/devices")) return json([{ serial: f.serial ?? "Q2XX-ABCD-1234" }]);
      if (!path.endsWith("/l3FirewallRules")) return json({ id: "N_1", organizationId: f.org ?? "555001" });
      f.gets += 1; return json({ rules: view() });
    }
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
  const http = createGuardedHttp({ allowedHosts: ["n1.meraki.corp.test"], fetchImpl: f.fetch });
  return liveOps(MX_T, createMerakiAdapter({ http, target: MX_T, env: ENV }));
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
  const rejected = await badKey.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  assert.equal(rejected.code, "scope_mismatch");
  assert.equal(rejected.detail, "network_not_found_or_key_rejected");
});

test("Meraki live: an edit made during the write is reported as uncertain with no repair", async () => {
  const f = fakeMeraki({ rules: [KEEP], editDuringWrite: true });
  const { done } = await run(mxOps(f), { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE }, true);
  assert.equal(done.operation.status, "uncertain");
  assert.equal(f.puts.length, 1, "no second write to 'fix' it");
});

test("target settings: live targets must be disposable lab targets with exact hosts and only change types the live adapter implements", () => {
  assert.deepEqual(loadTargets([PAN_T, MX_T], { live: true }).problems, []);
  const unscoped = loadTargets([{ ...PAN_T, firewallSerial: undefined, access: undefined, deviceGroup: "DG-1" }, { ...MX_T, id: "m9", organizationId: undefined, applianceSerial: undefined }], { live: true }).problems.join(" | ");
  assert.match(unscoped, /firewallSerial/); assert.match(unscoped, /access\.principals/); assert.match(unscoped, /device-group scoping is not implemented/); assert.match(unscoped, /organizationId/); assert.match(unscoped, /applianceSerial/);
  const bad = loadTargets([{ ...PAN_T, environment: "production" }, { ...MX_T, id: "m2", host: "*.meraki.com", changeTypes: ["sdwan.uplink-preference.set"] }, { ...PAN_T, id: "p3", disposable: false, credentialEnv: "lower" }], { live: true }).problems.join(" | ");
  assert.match(bad, /disposable lab target/);
  assert.match(bad, /exact host/);
  assert.match(bad, /no live adapter/);
  assert.match(bad, /credentialEnv/);
  assert.equal(loadTargets([{ id: "s", vendor: "meraki", label: "Sim", changeTypes: ["sdwan.uplink-preference.set"] }], { live: false }).problems.length, 0);
});

test("Palo Alto live: the commit and job lookup are typed methods, and neither accepts a command", async () => {
  const f = fakePan();
  const http = createGuardedHttp({ allowedHosts: ["fw.lab.corp.test"], fetchImpl: f.fetch });
  const a = createPaloAltoAdapter({ http, target: PAN_T, env: ENV });
  assert.equal(typeof a.submitPartialCommit, "function");
  assert.equal(typeof a.readCommitJob, "function");
  assert.equal(a.xmlApi, undefined, "no generic XML entry point is exposed");
  await assert.rejects(a.submitPartialCommit("</member></admin><evil/>"), /invalid_pan_admin/);
  await assert.rejects(a.readCommitJob("1; <x/>"), /invalid_pan_job_id/);
  assert.equal(f.calls.length, 0, "invalid input never reaches the network");
  assert.deepEqual(await a.submitPartialCommit("twin-api"), { jobId: "77" });
  assert.deepEqual(await a.readCommitJob("77"), { status: "FIN", result: "OK" });
});

test("Palo Alto live: the job id is persisted before polling begins", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "twin-lw-"));
  const file = join(dir, "ops.json");
  let persisted = null;
  const f = fakePan({ jobPolls: 2, firstPoll: () => { persisted = JSON.parse(readFileSync(file, "utf8"))[0].jobId; } });
  const http = createGuardedHttp({ allowedHosts: ["fw.lab.corp.test"], fetchImpl: f.fetch });
  const adapter = createPaloAltoAdapter({ http, target: PAN_T, env: ENV, sleep: async () => {}, pollMs: 0, maxPolls: 5 });
  const ops = createOperations({ resolver: createTargetResolver({ mode: "live", targets: new Map([[PAN_T.id, PAN_T]]), fixtures: SIMULATOR_TARGETS }), policy: createLivePolicy({ [PAN_T.id]: PAN_T.access.principals }), adapters: { paloalto: adapter }, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "live", liveAuthorized: () => true, file });
  const { done } = await run(ops, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(done.ok, true);
  assert.equal(persisted, "77");
});

test("Palo Alto live: 'no changes to commit' still requires the running-config read-back", async () => {
  const f = fakePan({ commitNoChanges: true });
  const { done } = await run(panOps(f), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(done.operation.status, "completed");
  assert.equal(done.operation.result.note, "no_changes_to_commit_running_verified");

  const never = fakePan({ commitNoChanges: true });
  const post = never.fetch;
  never.fetch = post;
  // If the object is not in the running configuration, 'no changes' must not be reported as success.
  const g = fakePan({ commitNoChanges: true });
  const orig = g.fetch;
  const http = createGuardedHttp({ allowedHosts: ["fw.lab.corp.test"], fetchImpl: async (u, i) => { const r = await orig(u, i); if (new URL(u).searchParams.get("type") === "commit") g.running = new Map(); return r; } });
  const adapter = createPaloAltoAdapter({ http, target: PAN_T, env: ENV, sleep: async () => {}, pollMs: 0, maxPolls: 2 });
  const ops = liveOps(PAN_T, adapter);
  const r2 = await run(ops, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(r2.done.operation.status, "uncertain");
  assert.equal(r2.done.operation.result.reason, "running_differs_after_commit");
});

test("Palo Alto live: an unreadable commit reply is reconciled against the running config and the commit is never resubmitted", async () => {
  const f = fakePan({ garbleCommitReply: true });
  const { done } = await run(panOps(f), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(f.commits, 1);
  assert.equal(done.operation.result.note, "commit_response_lost_running_verified");
});

test("Palo Alto live: a job reply for a different job id is not accepted as confirmation", async () => {
  const f = fakePan({ wrongJobId: true });
  const { done } = await run(panOps(f), { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(done.operation.status, "uncertain");
  assert.equal(done.operation.result.reason, "commit_job_not_finished");
});

// ---- commit journal: durable intent and job id, recovery without resubmitting
function journaled(f, { principals = ["u-op", "u-ap"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "twin-jr-"));
  mkdirSync(join(dir, "journal"));
  const journal = createCommitJournal(join(dir, "journal"));
  const file = join(dir, "ops.json");
  const http = createGuardedHttp({ allowedHosts: ["fw.lab.corp.test"], fetchImpl: f.fetch });
  const adapter = createPaloAltoAdapter({ http, target: PAN_T, env: ENV, sleep: async () => {}, pollMs: 0, maxPolls: 2 });
  const make = () => createOperations({ resolver: createTargetResolver({ mode: "live", targets: new Map([[PAN_T.id, PAN_T]]), fixtures: SIMULATOR_TARGETS }), policy: createLivePolicy({ [PAN_T.id]: principals }), adapters: { paloalto: adapter }, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "live", liveAuthorized: () => true, file, journal });
  return { journal, file, dir, make, ops: make() };
}
const planned = async (j) => {
  const r = await j.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  await j.ops.decide(AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest });
  return r.operation;
};

test("commit journal: intent is recorded before the commit and the job id after, bound to the fingerprint and plan digest", async () => {
  const f = fakePan();
  const j = journaled(f);
  const op = await planned(j);
  assert.equal((await j.ops.execute(OP, op.id)).ok, true);
  const rec = await j.journal.recover({ id: op.id, targetFingerprint: op.targetFingerprint, planDigest: op.planDigest });
  assert.deepEqual(rec, { state: "job_known", jobId: "77" });
  assert.equal(f.commits, 1);
});

test("commit journal: an intent that already exists blocks the commit, so a retry or restart cannot submit twice", async () => {
  const f = fakePan();
  const j = journaled(f);
  const op = await planned(j);
  await j.journal.recordIntent({ id: op.id, targetFingerprint: op.targetFingerprint, planDigest: op.planDigest });
  const done = await j.ops.execute(OP, op.id);
  assert.equal(done.operation.status, "uncertain");
  assert.equal(done.operation.result.reason, "commit_intent_already_recorded");
  assert.equal(f.commits ?? 0, 0, "no commit was sent");
  // Intent but no job: it is unknown whether a commit was submitted, so a person must look. Nothing is resubmitted.
  const rec = await j.ops.reconcile(OP, op.id);
  assert.equal(rec.code, "submission_uncertain_manual_review");
  assert.equal(f.commits ?? 0, 0);
});

test("commit journal: an unfinished job is reconciled later from the saved job id, without a second commit, even after a restart", async () => {
  const f = fakePan({ jobPolls: 99 });
  const j = journaled(f);
  const op = await planned(j);
  const first = await j.ops.execute(OP, op.id);
  assert.equal(first.operation.result.reason, "commit_job_not_finished");
  assert.equal((await j.ops.reconcile(OP, op.id)).operation.result.reason, "commit_job_not_finished", "still running: stays uncertain");
  f.finishJobs = true;
  // Simulate a restart while the operation was still marked executing.
  const saved = JSON.parse(_readFileSync(j.file, "utf8"));
  saved[0].status = "executing";
  _writeFileSync(j.file, JSON.stringify(saved));
  const restarted = j.make();
  await restarted.ready;
  assert.equal(restarted.get(OP, op.id).status, "uncertain");
  const done = await restarted.reconcile(OP, op.id);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.operation.status, "completed");
  assert.equal(done.operation.result.reconciled, true);
  assert.equal(f.commits, 1, "the commit was never resubmitted");
  assert.equal(f.running.size, 1);
});

test("commit journal: reconcile needs an uncertain operation, a journal binding that still matches, and current access", async () => {
  const f = fakePan({ jobPolls: 99 });
  const j = journaled(f);
  const done = await run(j.ops, { targetId: "lab-fw-1", changeType: "address-object.create", params: { ...ADDR, name: "other" } });
  assert.equal(done.done.operation.status, "uncertain");
  assert.equal((await j.ops.reconcile({ ...OP, subject: "stranger" }, done.id)).code, "not_found");
  assert.equal((await j.ops.reconcile({ ...OP, roles: ["viewer"] }, done.id)).code, "forbidden");

  const ok = fakePan();
  const j2 = journaled(ok);
  const op2 = await planned(j2);
  await j2.ops.execute(OP, op2.id);
  assert.equal((await j2.ops.reconcile(OP, op2.id)).code, "not_uncertain");

  const f3 = fakePan();
  const j3 = journaled(f3);
  const op3 = await planned(j3);
  await j3.journal.recordIntent({ id: op3.id, targetFingerprint: "a".repeat(64), planDigest: "b".repeat(64) });
  await j3.ops.execute(OP, op3.id);
  assert.equal((await j3.ops.reconcile(OP, op3.id)).code, "commit_binding_changed");

  const f4 = fakePan();
  const j4 = journaled(f4);
  const op4 = await planned(j4);
  await j4.ops.execute(OP, op4.id);
  assert.equal((await j4.journal.recover({ id: op4.id, targetFingerprint: op4.targetFingerprint, planDigest: op4.planDigest })).state, "job_known");
  assert.equal((await j4.journal.recover({ id: "OP-0000000000", targetFingerprint: op4.targetFingerprint, planDigest: op4.planDigest })).state, "no_intent");
});
