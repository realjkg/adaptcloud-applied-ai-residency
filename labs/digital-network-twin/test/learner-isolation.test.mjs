import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every local module reachable from an entry file through static or dynamic imports and re-exports. */
function graph(entry) {
  const seen = new Set();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) queue.push(resolve(dirname(file), m[1]));
  }
  return [...seen].map((f) => relative(root, f));
}

const DEPLOYED_FORBIDDEN = [/tools\/live\//, /tools\/collect\//, /adapters\/(paloalto|meraki)\.mjs$/, /server\/main\.mjs$/, /server\/live-authorization\.mjs$/, /server\/learner\.mjs$/];
const FORBIDDEN_MODULES = [/tools\/live\//, /tools\/collect\//, /adapters\/(paloalto|meraki)\.mjs$/, /server\/oidc\.mjs$/, /server\/main\.mjs$/, /server\/live-authorization\.mjs$/];

test("the learner entry reaches no live adapter, collector, identity client, or live-authorization module", () => {
  const files = graph(join(root, "server", "learner.mjs"));
  assert.ok(files.includes("server/operations.mjs") && files.includes("server/adapters/simulated.mjs"), "it does run the same workflow, simulated");
  for (const f of files) for (const re of FORBIDDEN_MODULES) assert.ok(!re.test(f), `${f} must not be reachable from the learner entry`);
});

test("nothing the learner entry reaches reads credentials or process environment, or opens an outbound connection", () => {
  for (const f of graph(join(root, "server", "learner.mjs"))) {
    const src = readFileSync(join(root, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/process\.env/.test(src), `${f} reads process.env`);
    assert.ok(!/\bfetch\s*\(|globalThis\.fetch|node:https\b|node:net\b|node:tls/.test(src.replace(/createServer/g, "")), `${f} makes outbound calls`);
    assert.ok(!/secretFromEnv|X-PAN-KEY|x-pan-key|Bearer /.test(src), `${f} handles vendor credentials`);
  }
});

test("the deployed learner entry cannot reach persona sign-in, live adapters, collectors, credentials, or the local test entry", () => {
  const files = graph(join(root, "server", "learner-deployed.mjs"));
  assert.ok(files.includes("server/oidc.mjs") && files.includes("server/enrollment.mjs"), "it signs people in with OIDC and resolves enrollment");
  for (const f of files) {
    for (const re of DEPLOYED_FORBIDDEN) assert.ok(!re.test(f), `${f} must not be reachable from the deployed learner entry`);
    const src = readFileSync(join(root, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/\bPERSONAS\b/.test(src), `${f} defines the persona table`);
    assert.ok(!/process\.env/.test(src), `${f} reads process.env`);
    assert.ok(!/secretFromEnv|X-PAN-KEY|x-pan-key/.test(src), `${f} handles vendor credentials`);
  }
});

test("the local persona test entry is a separate file that nothing deployed imports", () => {
  for (const entry of ["learner-deployed.mjs", "main.mjs"]) assert.ok(!graph(join(root, "server", entry)).includes("server/learner.mjs"), `${entry} must not import the persona entry`);
  const learner = readFileSync(join(root, "server", "learner.mjs"), "utf8");
  assert.match(learner, /LOCAL TEST ENTRY/);
});

test("the live entry is the only place that wires live adapters", () => {
  const main = graph(join(root, "server", "main.mjs"));
  assert.ok(main.includes("server/adapters/paloalto.mjs") && main.includes("server/adapters/meraki.mjs"));
});

test("learner personas can plan, approve, and execute simulated writes including SD-WAN, with no live target available", async () => {
  const { createSimulatorService } = await import("../server/learner.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const svc = await createSimulatorService({ dir: mkdtempSync(join(tmpdir(), "twin-learner-")), origin: "http://x" });
  const opA = { subject: "persona:operator", name: "A", roles: ["operator"], labId: "lab-a" };
  const apA = { subject: "persona:approver", name: "B", roles: ["approver"], labId: "lab-a" };
  const targets = svc.operations.targets(opA);
  assert.deepEqual(targets.map((t) => t.id).sort(), ["mx-aus-branch", "pan-dfw-edge"], "a learner sees only the devices in their own lab");
  assert.ok(targets.every((t) => t.environment === "lab" && t.disposable && !("scope" in t)));
  assert.ok(targets.find((t) => t.id === "mx-aus-branch").changeTypes.some((c) => c.id === "sdwan.uplink-preference.set"));
  const r = await svc.operations.request(opA, { targetId: "mx-aus-branch", changeType: "sdwan.uplink-preference.set", params: { trafficClass: "voice", preferredUplink: "wan2" } });
  await svc.operations.decide(apA, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: true });
  assert.equal((await svc.operations.execute(opA, r.operation.id)).operation.transport, "simulator");
  assert.equal(svc.sim.sdwanFor("L_790001000000000001").prefs.voice, "wan2");
  assert.equal(svc.sim.sdwanFor("L_790001000000000002").prefs.voice, "wan1", "the other lab's network is untouched");
  assert.equal((await svc.operations.request(opA, { targetId: "lab-fw-1", changeType: "address-object.create", params: {} })).code, "target_not_available");
});

test("two learners cannot read, approve, execute, or roll back each other's operations", async () => {
  const { createSimulatorService } = await import("../server/learner.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const svc = await createSimulatorService({ dir: mkdtempSync(join(tmpdir(), "twin-learner-")), origin: "http://x" });
  const opA = { subject: "persona:operator", name: "A", roles: ["operator"], labId: "lab-a" };
  const apA = { subject: "persona:approver", name: "Aa", roles: ["approver"], labId: "lab-a" };
  const opB = { subject: "persona:operator-b", name: "B", roles: ["operator"], labId: "lab-b" };
  const apB = { subject: "persona:approver-b", name: "Bb", roles: ["approver"], labId: "lab-b" };
  const r = await svc.operations.request(opA, { targetId: "pan-dfw-edge", changeType: "address-object.create", params: { name: "web", ipNetmask: "10.1.0.0/24" } });
  assert.equal(r.ok, true);
  const id = r.operation.id;
  assert.deepEqual(svc.operations.list(opB), []);
  assert.equal(svc.operations.get(opB, id), null);
  assert.equal((await svc.operations.decide(apB, id, { decision: "approve", planDigest: r.operation.planDigest })).code, "not_found");
  await svc.operations.decide(apA, id, { decision: "approve", planDigest: r.operation.planDigest });
  assert.equal((await svc.operations.execute(opB, id)).code, "not_found");
  assert.equal((await svc.operations.rollback(opB, id)).code, "not_found");
  // B cannot name A's devices either, and gets the same answer as for a device that does not exist.
  assert.equal((await svc.operations.request(opB, { targetId: "pan-dfw-edge", changeType: "address-object.create", params: { name: "x", ipNetmask: "10.2.0.0/24" } })).code, "target_not_available");
  assert.equal((await svc.operations.request(opB, { targetId: "nope", changeType: "address-object.create", params: {} })).code, "target_not_available");
  assert.equal((await svc.operations.execute(opA, id)).ok, true);
  assert.equal(svc.sim.panFor("019801234561").object.size, 0);
  assert.equal(svc.sim.panFor("019801234560").running.size, 1);
});
