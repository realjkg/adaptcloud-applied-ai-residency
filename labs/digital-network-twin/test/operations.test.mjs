import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperations } from "../server/operations.mjs";
import { createSimulatedAdapters } from "../server/adapters/simulated.mjs";
import { createAudit } from "../server/audit.mjs";
import { createTargetResolver, TargetError } from "../server/target-resolution.mjs";

const LAB = "lab-t";
const OP = { subject: "u-op", name: "Op", roles: ["operator"], labId: LAB };
const AP = { subject: "u-ap", name: "Ap", roles: ["approver"], labId: LAB };
const AP2 = { subject: "u-ap2", name: "Ap2", roles: ["approver"], labId: LAB };
const VIEW = { subject: "u-v", name: "V", roles: ["viewer"], labId: LAB };
const TARGETS = new Map([
  ["lab-fw-1", { id: "lab-fw-1", label: "Lab firewall", vendor: "paloalto", environment: "lab", disposable: true, vsys: "vsys1", commitAdmin: "twin-api", changeTypes: ["address-object.create", "address-object.delete"] }],
  ["lab-mx-1", { id: "lab-mx-1", label: "Lab MX", vendor: "meraki", environment: "lab", disposable: true, changeTypes: ["l3-firewall-rule.add", "l3-firewall-rule.remove", "sdwan.uplink-preference.set"] }],
  ["lab-mx-2", { id: "lab-mx-2", label: "Lab MX read-mostly", vendor: "meraki", environment: "lab", disposable: true, changeTypes: ["l3-firewall-rule.add"] }]
]);
const ADDR = { name: "web-servers", ipNetmask: "10.30.0.0/24", description: "lab web tier" };
const RULE = { policy: "allow", protocol: "tcp", srcCidr: "10.40.0.0/24", srcPort: "any", destCidr: "10.20.0.100/32", destPort: "443", comment: "branch web" };

function setup({ targets = TARGETS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "twin-ops-"));
  const clock = { t: Date.parse("2026-11-19T10:00:00Z") };
  const { sim, adapters } = createSimulatedAdapters();
  const audit = createAudit({ file: join(dir, "audit.jsonl"), now: () => new Date(clock.t) });
  let kill = false;
  // The test resolver reads the live Map, so removing an alias from it takes effect immediately.
  const inner = () => createTargetResolver({ mode: "simulator", targets });
  const resolver = { mode: "simulator", resolve: (a, c) => inner().resolve(a, c), aliases: () => [...targets.keys()], inspect: (a) => inner().inspect(a) };
  const policy = { allows: () => true };
  const mk = () => createOperations({ resolver, policy, adapters, audit, now: () => new Date(clock.t), killSwitch: () => kill, transportKind: "simulator", file: join(dir, "ops.json") });
  return { ops: mk(), remake: mk, sim, clock, audit, dir, kill: (v) => { kill = v; } };
}
const approve = (t, id, who = AP, extra = {}) => t.ops.decide(who, id, { decision: "approve", planDigest: t.ops.get(OP, id).planDigest, exclusiveWindow: true, ...extra });
async function fullRun(t, req, extra) {
  const r = await t.ops.request(OP, req);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await approve(t, r.operation.id, AP, extra)).ok, true);
  return { id: r.operation.id, result: await t.ops.execute(OP, r.operation.id) };
}

test("Palo Alto: candidate edit and commit are separate in the plan, and a verified run reads back the running config", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.deepEqual(r.operation.commitScope, { kind: "partial", byAdmin: "twin-api", vsys: "vsys1", objects: ["web-servers"], pendingBefore: 0 });
  assert.match(r.operation.diff.after[0].line, /twin-op:OP-[0-9A-F]{10}/);
  assert.equal(t.sim.pan.running.size, 0, "planning writes nothing");
  await approve(t, r.operation.id);
  const done = await t.ops.execute(OP, r.operation.id);
  assert.equal(done.ok, true);
  assert.equal(done.operation.result.stage, "verify");
  assert.equal(t.sim.pan.running.size, 1);
  assert.equal(t.sim.pan.pending, 0);
});

test("Palo Alto: refuses to plan when the candidate already has pending changes", async () => {
  const t = setup();
  t.sim.pan.pending = 2;
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal(r.code, "blocked");
  assert.deepEqual(r.blockers, ["pending_candidate_changes_exist"]);
});

test("Palo Alto: a commit that fails or never finishes is not reported as success, and the candidate is flagged", async () => {
  for (const [mode, status, reason] of [["commit-fail", "failed", "commit_job_fail"], ["commit-stuck", "uncertain", "commit_job_not_finished"]]) {
    const t = setup();
    const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
    await approve(t, r.operation.id);
    t.sim.nextWrite = mode;
    const done = await t.ops.execute(OP, r.operation.id);
    assert.equal(done.ok, false);
    assert.equal(done.operation.status, status);
    assert.equal(done.operation.result.reason, reason);
  }
});

test("Meraki: the approver sees the whole before and after list, unrelated rules survive, and a verified run reads the list back", async () => {
  const t = setup();
  t.sim.mx.rules = [{ comment: "keep-1", policy: "deny", protocol: "any", srcPort: "any", srcCidr: "any", destPort: "any", destCidr: "10.0.0.0/8", syslogEnabled: false }, { comment: "keep-2", policy: "allow", protocol: "udp", srcPort: "any", srcCidr: "10.1.0.0/16", destPort: "53", destCidr: "any", syslogEnabled: true }];
  const before = structuredClone(t.sim.mx.rules);
  const r = await t.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  assert.equal(r.operation.diff.before.length, 2);
  assert.equal(r.operation.diff.after.length, 3);
  assert.equal(r.operation.diff.unrelatedRulesUnchanged, true);
  assert.ok(r.operation.diff.after.filter((l) => l.change === "kept").length === 2);
  assert.equal(r.operation.requiresExclusiveWindow, true);
  await approve(t, r.operation.id);
  assert.equal((await t.ops.execute(OP, r.operation.id)).ok, true);
  assert.deepEqual(t.sim.mx.rules.slice(0, 2), before);
  assert.equal(t.sim.mx.rules.length, 3);
});

test("Meraki: the approver must confirm an exclusive change window", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  const no = await t.ops.decide(AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest });
  assert.equal(no.code, "exclusive_window_confirmation_required");
  assert.equal((await approve(t, r.operation.id)).ok, true);
});

test("self-approval is refused, including for a person who holds both roles", async () => {
  const t = setup();
  const both = { subject: "u-both", name: "Both", roles: ["operator", "approver"] };
  const r = await t.ops.request(both, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal((await t.ops.decide(both, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest })).code, "self_approval");
  assert.equal((await t.ops.decide(OP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest })).code, "forbidden");
});

test("an approval is bound to the plan the approver saw, and an expired plan cannot be approved or executed", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  assert.equal((await t.ops.decide(AP, r.operation.id, { decision: "approve", planDigest: "0".repeat(64) })).code, "plan_digest_mismatch");
  t.clock.t += 31 * 60_000;
  assert.equal((await t.ops.decide(AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest })).code, "plan_expired");

  const t2 = setup();
  const r2 = await t2.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  await approve(t2, r2.operation.id);
  t2.clock.t += 31 * 60_000;
  const late = await t2.ops.execute(OP, r2.operation.id);
  assert.equal(late.code, "approval_expired");
  assert.equal(t2.sim.pan.object.size, 0, "nothing was written");
});

test("the browser cannot choose a target, change type, host, URL, or command outside the allowlist", async () => {
  const t = setup();
  const bad = [
    { targetId: "prod-fw-9", changeType: "address-object.create", params: ADDR },
    { targetId: "lab-fw-1", changeType: "l3-firewall-rule.add", params: RULE },
    { targetId: "lab-mx-2", changeType: "sdwan.uplink-preference.set", params: { trafficClass: "voice", preferredUplink: "wan2" } },
    { targetId: "lab-fw-1", changeType: "commit", params: {} },
    { targetId: "lab-fw-1", changeType: "address-object.create", params: { ...ADDR, name: "x'] | evil" } },
    { targetId: "lab-fw-1", changeType: "address-object.create", params: { ...ADDR, ipNetmask: "10.0.0.0/8; rm" } }
  ];
  const codes = [];
  for (const b of bad) codes.push((await t.ops.request(OP, b)).code);
  assert.deepEqual(codes, ["target_not_available", "target_not_available", "target_not_available", "target_not_available", "params_invalid", "params_invalid"]);
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR, url: "https://evil.example/", host: "evil.example", cmd: "<commit/>" });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes("evil.example"));
  assert.equal((await t.ops.request(VIEW, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR })).code, "forbidden");
});

test("a target removed from the allowlist after approval cannot be executed against", async () => {
  const targets = new Map(TARGETS);
  const t = setup({ targets });
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  await approve(t, r.operation.id);
  targets.delete("lab-fw-1");
  assert.equal((await t.ops.execute(OP, r.operation.id)).code, "not_found", "an alias that no longer resolves reveals nothing");
  assert.equal(t.sim.pan.object.size, 0);
});

test("drift between approval and execution marks the plan stale and writes nothing; a new plan is needed", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  await approve(t, r.operation.id);
  t.sim.mx.rules.push({ comment: "someone-else", policy: "allow", protocol: "any", srcPort: "any", srcCidr: "any", destPort: "any", destCidr: "any", syslogEnabled: false });
  const done = await t.ops.execute(OP, r.operation.id);
  assert.equal(done.code, "drift_detected_new_plan_required");
  assert.equal(done.operation.status, "stale");
  assert.equal(t.sim.mx.rules.length, 1, "the other person's rule is untouched and nothing was added");
  assert.equal(t.sim.writes, 0);
  const again = await t.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  assert.equal(again.operation.diff.before.length, 1);
  assert.notEqual(again.operation.planDigest, r.operation.planDigest);
});

test("a retry or a concurrent execute returns the existing operation and writes once", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  await approve(t, r.operation.id);
  const [a, b] = await Promise.all([t.ops.execute(OP, r.operation.id), t.ops.execute(OP, r.operation.id)]);
  const c = await t.ops.execute(OP, r.operation.id);
  assert.equal(t.sim.writes, 1);
  assert.equal(a.operation.status, "completed");
  assert.equal(b.operation.status, "completed");
  assert.equal(c.existing, true);
  assert.equal(t.sim.mx.rules.length, 1);
});

test("a lost response is verified before any retry: applied is accepted, not applied is retried once, anything else is uncertain", async () => {
  const lost = setup();
  const a = await lost.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  await approve(lost, a.operation.id);
  lost.sim.nextWrite = "lost";
  const done = await lost.ops.execute(OP, a.operation.id);
  assert.equal(done.operation.status, "completed");
  assert.equal(done.operation.result.note, "write_response_lost_state_verified");
  assert.equal(lost.sim.writes, 1, "verified without a second write");

  const dropped = setup();
  const b = await dropped.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  await approve(dropped, b.operation.id);
  dropped.sim.nextWrite = "dropped";
  const retried = await dropped.ops.execute(OP, b.operation.id);
  assert.equal(retried.operation.status, "completed");
  assert.equal(retried.operation.result.attempts, 2);
  assert.equal(dropped.sim.writes, 1);

  const refused = setup();
  const c = await refused.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  await approve(refused, c.operation.id);
  refused.sim.nextWrite = "refuse";
  assert.equal((await refused.ops.execute(OP, c.operation.id)).operation.status, "failed");
  assert.equal(refused.sim.writes, 0);
});

test("when the target ends in neither state the operation is uncertain and nothing more is written", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  await approve(t, r.operation.id);
  // Someone edits the list during the write: after the drift check, reads return a list that is neither state.
  const real = t.sim.mx;
  let reads = 0;
  Object.defineProperty(real, "rules", { configurable: true, get() { reads += 1; return reads >= 2 ? [{ comment: "intruder", policy: "allow", protocol: "any", srcPort: "any", srcCidr: "any", destPort: "any", destCidr: "any", syslogEnabled: false }] : []; }, set() {} });
  const done = await t.ops.execute(OP, r.operation.id);
  assert.equal(done.operation.status, "uncertain");
  assert.equal(done.operation.result.reason, "state_differs_from_both");
  assert.ok(done.operation.result.observedDigest);
});

test("rollback is a separate change with its own approval, and it is refused if the object was edited afterward", async () => {
  const t = setup();
  const { id } = await fullRun(t, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  const rb = await t.ops.rollback(OP, id);
  assert.equal(rb.ok, true);
  assert.equal(rb.operation.changeType, "address-object.delete");
  assert.equal(rb.operation.rollbackOf, id);
  assert.equal(rb.operation.status, "pending_approval");
  assert.equal(t.sim.pan.running.size, 1, "requesting a rollback restores nothing");
  assert.equal((await t.ops.execute(OP, rb.operation.id)).code, "not_approved");
  await approve(t, rb.operation.id, AP2);
  assert.equal((await t.ops.execute(OP, rb.operation.id)).ok, true);
  assert.equal(t.sim.pan.running.size, 0);

  const t2 = setup();
  const { id: id2 } = await fullRun(t2, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  const stored = t2.sim.pan.object.get("web-servers");
  t2.sim.pan.object.set("web-servers", { ...stored, ipNetmask: "10.99.0.0/16" });
  const blocked = await t2.ops.rollback(OP, id2);
  assert.equal(blocked.code, "blocked");
  assert.deepEqual(blocked.blockers, ["object_changed_since_creation"]);

  const t3 = setup();
  const { id: id3 } = await fullRun(t3, { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: RULE });
  t3.sim.mx.rules = t3.sim.mx.rules.map((r) => ({ ...r, destPort: "8443" }));
  assert.deepEqual((await t3.ops.rollback(OP, id3)).blockers, ["rule_changed_since_creation"]);
});

test("simulated SD-WAN changes follow the same workflow and can be reversed to the prior value", async () => {
  const t = setup();
  const { id, result } = await fullRun(t, { targetId: "lab-mx-1", changeType: "sdwan.uplink-preference.set", params: { trafficClass: "voice", preferredUplink: "wan2" } });
  assert.equal(result.ok, true);
  assert.equal(t.sim.sdwan.prefs.voice, "wan2");
  assert.equal(t.sim.sdwan.prefs.video, "wan1", "other classes are untouched");
  const rb = await t.ops.rollback(OP, id);
  assert.equal(rb.operation.params.preferredUplink, "wan1");
  await approve(t, rb.operation.id, AP2);
  await t.ops.execute(OP, rb.operation.id);
  assert.equal(t.sim.sdwan.prefs.voice, "wan1");
});

test("the kill switch refuses new requests and executions", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  await approve(t, r.operation.id);
  t.kill(true);
  assert.equal((await t.ops.execute(OP, r.operation.id)).code, "kill_switch_engaged");
  assert.equal((await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: { ...ADDR, name: "other" } })).code, "kill_switch_engaged");
  assert.equal(t.sim.pan.object.size, 0);
});

test("operations survive a restart, and one found mid-write becomes uncertain instead of being run again", async () => {
  const t = setup();
  const r = await t.ops.request(OP, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  await approve(t, r.operation.id);
  const file = join(t.dir, "ops.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved[0].status = "executing";
  (await import("node:fs")).writeFileSync(file, JSON.stringify(saved));
  const again = t.remake();
  const view = (await (async () => { await again.ready; return again.get(OP, r.operation.id); })());
  assert.equal(view.status, "uncertain");
  assert.equal(view.result.reason, "service_restarted_during_write");
  assert.equal((await again.execute(OP, r.operation.id)).existing, true);
  assert.equal(t.sim.writes, 0);
});

test("every step is audited with identities, and the chain verifies", async () => {
  const t = setup();
  await fullRun(t, { targetId: "lab-fw-1", changeType: "address-object.create", params: ADDR });
  const events = (await t.audit.read()).map((e) => e.event);
  for (const e of ["operation.requested", "operation.approved", "operation.executing", "operation.executed"]) assert.ok(events.includes(e), e);
  assert.equal((await t.audit.verify()).ok, true);
});
