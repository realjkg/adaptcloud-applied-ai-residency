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

test("the live entry is the only place that wires live adapters", () => {
  const main = graph(join(root, "server", "main.mjs"));
  assert.ok(main.includes("server/adapters/paloalto.mjs") && main.includes("server/adapters/meraki.mjs"));
});

test("learner personas can plan, approve, and execute simulated writes including SD-WAN, with no live target available", async () => {
  const { createSimulatorService } = await import("../server/learner.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const svc = await createSimulatorService({ dir: mkdtempSync(join(tmpdir(), "twin-learner-")), origin: "http://x" });
  const targets = svc.operations.targets();
  assert.deepEqual(targets.map((t) => t.id).sort(), ["sim-fw-1", "sim-mx-1"]);
  assert.ok(targets.every((t) => t.environment === "lab" && t.disposable));
  assert.ok(targets.find((t) => t.id === "sim-mx-1").changeTypes.some((c) => c.id === "sdwan.uplink-preference.set"));
  const r = await svc.operations.request({ subject: "a", name: "A", roles: ["operator"] }, { targetId: "sim-mx-1", changeType: "sdwan.uplink-preference.set", params: { trafficClass: "voice", preferredUplink: "wan2" } });
  await svc.operations.decide({ subject: "b", name: "B", roles: ["approver"] }, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: true });
  assert.equal((await svc.operations.execute({ subject: "a", name: "A", roles: ["operator"] }, r.operation.id)).operation.transport, "simulator");
  assert.equal(svc.sim.sdwan.prefs.voice, "wan2");
  assert.equal((await svc.operations.request({ subject: "a", name: "A", roles: ["operator"] }, { targetId: "lab-fw-1", changeType: "address-object.create", params: {} })).code, "target_not_allowlisted");
});
