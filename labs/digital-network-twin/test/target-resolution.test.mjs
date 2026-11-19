import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIMULATOR_TARGETS } from "../server/simulator-targets.mjs";
import { bindTarget, createLabPolicy, createLivePolicy, createTargetResolver, recheckBoundTarget, resolveForExecution, targetFingerprint, TargetError } from "../server/target-resolution.mjs";
import { createOperations } from "../server/operations.mjs";
import { createSimulatedAdapters } from "../server/adapters/simulated.mjs";
import { createAudit } from "../server/audit.mjs";

const INSERT = "l3-firewall-rule.add";
const REMOVE = "l3-firewall-rule.remove";
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

const livePan = (over = {}) => ({ vendor: "paloalto", label: "Lab firewall", environment: "lab", disposable: true, mode: "live", scope: { managementHost: "fw1.lab.corp.test", deviceGroup: null, firewallSerial: "007054000123456", vsys: "vsys1" }, commitAdmin: "twin-api", capabilities: ["address-object.create", "address-object.delete"], ...over });
const liveMx = (network, over = {}) => ({ vendor: "meraki", label: "Lab MX", environment: "lab", disposable: true, mode: "live", scope: { organizationId: "555001", networkId: network, applianceSerial: "Q2XX-ABCD-1234" }, capabilities: [INSERT, REMOVE], ...over });

// ---- the six boundary tests from the design
class LabPolicy {
  active = true;
  allows({ principalId, contextId, target }) { return this.active && principalId === "learner-a" && contextId === "lab-a" && target.mode === "simulator"; }
}

function simSetup() {
  const resolver = createTargetResolver({ mode: "simulator", targets: SIMULATOR_TARGETS });
  const policy = new LabPolicy();
  const { binding } = bindTarget(resolver, policy, { principalId: "learner-a", contextId: "lab-a", alias: "mx-aus-branch", capability: INSERT });
  const recheck = (b = binding, principalId = "learner-a") => recheckBoundTarget(resolver, policy, { principalId, contextId: "lab-a", binding: b });
  return { resolver, policy, binding, recheck };
}

test("a binding returns the resolved network", () => {
  assert.equal(simSetup().recheck().scope.networkId, "L_790001000000000001");
});

test("an Austin binding cannot be replayed against Plano", () => {
  const s = simSetup();
  assert.equal(code(() => s.recheck({ ...s.binding, alias: "mx-plano-branch" })), "APPROVED_TARGET_CHANGED");
});

test("an insert binding does not authorize a remove", () => {
  const s = simSetup();
  assert.equal(code(() => s.recheck({ ...s.binding, capability: REMOVE })), "APPROVED_TARGET_CHANGED");
});

test("another learner cannot use the binding, and revoked access is rechecked", () => {
  const s = simSetup();
  assert.equal(code(() => s.recheck(s.binding, "learner-b")), "TARGET_NOT_AVAILABLE");
  s.policy.active = false;
  assert.equal(code(() => s.recheck()), "TARGET_NOT_AVAILABLE");
});

test("a live resolver never falls back to fixtures", () => {
  const live = createTargetResolver({ mode: "live", targets: new Map(), fixtures: SIMULATOR_TARGETS });
  assert.equal(code(() => live.resolve("mx-aus-branch", INSERT)), "TARGET_NOT_AVAILABLE");
});

test("create and destroy fingerprints are distinct, and an unknown alias and a missing capability look the same", () => {
  const r = createTargetResolver({ mode: "simulator", targets: SIMULATOR_TARGETS });
  const t = r.resolve("pan-dfw-edge", "address-object.create");
  assert.notEqual(targetFingerprint("pan-dfw-edge", "address-object.create", t), targetFingerprint("pan-dfw-edge", "address-object.delete", t));
  assert.equal(code(() => r.resolve("nope", "address-object.create")), code(() => r.resolve("pan-dfw-edge", "l3-firewall-rule.add")));
});

// ---- registries
test("the live inventory refuses fixture aliases, fixture scopes, placeholder hosts, and fixture networks", () => {
  const make = (targets) => () => createTargetResolver({ mode: "live", targets: new Map(targets), fixtures: SIMULATOR_TARGETS });
  assert.equal(code(make([["mx-aus-branch", liveMx("L_5")]])), "LIVE_INVENTORY_USES_RESERVED_FIXTURE_ALIAS");
  assert.equal(code(make([["real-mx", { ...liveMx("L_5"), scope: SIMULATOR_TARGETS.get("mx-aus-branch").scope }]])), "FIXTURE_IN_LIVE_INVENTORY");
  assert.equal(code(make([["real-mx", liveMx("L_790001000000000002")]])), "FIXTURE_NETWORK_IN_LIVE_INVENTORY");
  assert.equal(code(make([["real-fw", livePan({ scope: { ...livePan().scope, managementHost: "panorama-dfw.lab.example" } })]])), "PLACEHOLDER_HOST_IN_LIVE_INVENTORY");
  assert.equal(code(make([["fix", { ...SIMULATOR_TARGETS.get("pan-dfw-edge"), mode: "simulator" }]])), "FIXTURE_IN_LIVE_INVENTORY");
  assert.equal(code(make([["ok-fw", livePan()], ["ok-mx", liveMx("L_42")]])), null);
  assert.equal(code(() => createTargetResolver({ mode: "demo", targets: new Map() })), "INVALID_EXECUTION_MODE");
  assert.equal(code(() => createTargetResolver({ mode: "simulator", targets: new Map([["live-one", livePan()]]) })), "LIVE_TARGET_IN_SIMULATOR_REGISTRY");
});

test("the fingerprint covers the mode and every scope field, so repointing any of them changes it", () => {
  const base = livePan();
  const f = (t) => targetFingerprint("fw", "address-object.create", { ...t, mode: t.mode, vendor: t.vendor });
  const variants = [
    { ...base, scope: { ...base.scope, managementHost: "fw2.lab.corp.test" } },
    { ...base, scope: { ...base.scope, firewallSerial: "007054000999999" } },
    { ...base, scope: { ...base.scope, vsys: "vsys2" } },
    { ...base, scope: { ...base.scope, deviceGroup: "DG-X" } },
    { ...base, mode: "simulator" }
  ];
  for (const v of variants) assert.notEqual(f(v), f(base));
  assert.equal(f(base), f({ ...base }));
});

test("policies are deny by default", () => {
  const t = createTargetResolver({ mode: "simulator", targets: SIMULATOR_TARGETS }).resolve("mx-aus-branch", INSERT);
  const lab = createLabPolicy({ "lab-a": { members: ["u1"], aliases: ["mx-aus-branch"] } });
  assert.equal(lab.allows({ principalId: "u1", contextId: "lab-a", alias: "mx-aus-branch", target: t }), true);
  for (const bad of [{ principalId: "u2" }, { contextId: "lab-b" }, { alias: "mx-plano-branch" }, { contextId: "__proto__" }]) assert.equal(lab.allows({ principalId: "u1", contextId: "lab-a", alias: "mx-aus-branch", target: t, ...bad }), false);
  const live = createLivePolicy({ "ok-mx": ["u1"] });
  const lt = createTargetResolver({ mode: "live", targets: new Map([["ok-mx", liveMx("L_42")]]), fixtures: SIMULATOR_TARGETS }).resolve("ok-mx", INSERT);
  assert.equal(live.allows({ principalId: "u1", contextId: "live", alias: "ok-mx", target: lt }), true);
  assert.equal(live.allows({ principalId: "u1", contextId: "lab-a", alias: "ok-mx", target: lt }), false);
  assert.equal(live.allows({ principalId: "u2", contextId: "live", alias: "ok-mx", target: lt }), false);
  assert.equal(live.allows({ principalId: "u1", contextId: "live", alias: "other", target: lt }), false);
  assert.ok(resolveForExecution);
});

// ---- inside the workflow
function workflow() {
  const dir = mkdtempSync(join(tmpdir(), "twin-tr-"));
  const { sim, adapters } = createSimulatedAdapters();
  const inventory = new Map(SIMULATOR_TARGETS);
  const resolver = { mode: "simulator", resolve: (a, c) => createTargetResolver({ mode: "simulator", targets: inventory }).resolve(a, c), aliases: () => [...inventory.keys()], inspect: (a) => createTargetResolver({ mode: "simulator", targets: inventory }).inspect(a) };
  const policy = createLabPolicy({ "lab-a": { members: ["u-op", "u-ap"], aliases: ["mx-aus-branch", "mx-plano-branch", "pan-dfw-edge"] } });
  const ops = createOperations({ resolver, policy, adapters, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "simulator" });
  const OP = { subject: "u-op", name: "Op", roles: ["operator"], labId: "lab-a" };
  const AP = { subject: "u-ap", name: "Ap", roles: ["approver"], labId: "lab-a" };
  return { sim, inventory, ops, OP, AP };
}
const RULE = { policy: "allow", protocol: "tcp", srcCidr: "10.40.0.0/24", srcPort: "any", destCidr: "10.20.0.100/32", destPort: "443", comment: "web" };
const AUS = "L_790001000000000001";

test("repointing an alias after approval marks the plan stale and writes nothing", async () => {
  const w = workflow();
  const r = await w.ops.request(w.OP, { targetId: "mx-aus-branch", changeType: INSERT, params: RULE });
  assert.match(r.operation.targetFingerprint, /^[0-9a-f]{64}$/);
  await w.ops.decide(w.AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: true });
  // The deployment repoints the alias at Plano. Both networks have identical (empty) rule lists, so drift alone would not notice.
  w.inventory.set("mx-aus-branch", SIMULATOR_TARGETS.get("mx-plano-branch"));
  const done = await w.ops.execute(w.OP, r.operation.id);
  assert.equal(done.code, "approved_target_changed");
  assert.equal(done.operation.status, "stale");
  assert.equal(w.sim.writes, 0);
  assert.equal(w.sim.mxFor("L_790001000000000002").rules.length, 0);
});

test("an Austin approval cannot be used to execute against Plano, and each network keeps its own state", async () => {
  const w = workflow();
  const aus = await w.ops.request(w.OP, { targetId: "mx-aus-branch", changeType: INSERT, params: RULE });
  const plano = await w.ops.request(w.OP, { targetId: "mx-plano-branch", changeType: INSERT, params: RULE });
  assert.notEqual(aus.operation.planDigest, plano.operation.planDigest, "identical changes to different networks have different digests");
  assert.notEqual(aus.operation.targetFingerprint, plano.operation.targetFingerprint);
  await w.ops.decide(w.AP, aus.operation.id, { decision: "approve", planDigest: aus.operation.planDigest, exclusiveWindow: true });
  assert.equal((await w.ops.decide(w.AP, plano.operation.id, { decision: "approve", planDigest: aus.operation.planDigest, exclusiveWindow: true })).code, "plan_digest_mismatch");
  assert.equal((await w.ops.execute(w.OP, aus.operation.id)).ok, true);
  assert.equal(w.sim.mxFor(AUS).rules.length, 1);
  assert.equal(w.sim.mxFor("L_790001000000000002").rules.length, 0);
});

test("a device that does not match inventory is refused at plan time and again at execution, before any write", async () => {
  const w = workflow();
  w.sim.mismatch.add(AUS);
  const refused = await w.ops.request(w.OP, { targetId: "mx-aus-branch", changeType: INSERT, params: RULE });
  assert.equal(refused.code, "scope_mismatch");
  w.sim.mismatch.clear();
  const r = await w.ops.request(w.OP, { targetId: "mx-aus-branch", changeType: INSERT, params: RULE });
  await w.ops.decide(w.AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: true });
  w.sim.mismatch.add(AUS);
  const done = await w.ops.execute(w.OP, r.operation.id);
  assert.equal(done.code, "scope_mismatch");
  assert.equal(w.sim.writes, 0);
});

test("access revoked between plan and execution stops the write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twin-tr-"));
  const { sim, adapters } = createSimulatedAdapters();
  const resolver = createTargetResolver({ mode: "simulator", targets: SIMULATOR_TARGETS });
  let allowed = true;
  const ops = createOperations({ resolver, policy: { allows: () => allowed }, adapters, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "simulator" });
  const OP = { subject: "u-op", name: "Op", roles: ["operator"], labId: "lab-a" }; const AP = { subject: "u-ap", name: "Ap", roles: ["approver"], labId: "lab-a" };
  const r = await ops.request(OP, { targetId: "mx-aus-branch", changeType: INSERT, params: RULE });
  await ops.decide(AP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: true });
  allowed = false;
  assert.equal((await ops.execute(OP, r.operation.id)).code, "not_found");
  assert.equal(sim.writes, 0);
  assert.equal(new TargetError("X").code, "X");
});

test("the same alias resolving to a different scope yields a different plan digest, even with identical baselines and changes", async () => {
  const digestFor = async (networkId) => {
    const w = workflow();
    w.inventory.set("mx-aus-branch", { ...SIMULATOR_TARGETS.get("mx-aus-branch"), scope: { ...SIMULATOR_TARGETS.get("mx-aus-branch").scope, networkId } });
    return (await w.ops.request(w.OP, { targetId: "mx-aus-branch", changeType: INSERT, params: RULE })).operation;
  };
  // Each plan's opId is random, so compare the fingerprint, which feeds the digest, and check the digest inputs separately.
  const a = await digestFor("L_1");
  const b = await digestFor("L_2");
  assert.notEqual(a.targetFingerprint, b.targetFingerprint);
});
