import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadiness } from "../server/readiness.mjs";
import { createLocalStorageRunner } from "../server/storage-runner-local.mjs";
import { createSimulatorService } from "../server/learner.mjs";
import { createOperations } from "../server/operations.mjs";
import { createSimulatedAdapters } from "../server/adapters/simulated.mjs";
import { createAudit } from "../server/audit.mjs";
import { createLabPolicy, createTargetResolver } from "../server/target-resolution.mjs";
import { SIMULATOR_TARGETS } from "../server/simulator-targets.mjs";

const ADMIN = { subject: "persona:admin", name: "Adel", roles: ["admin", "approver"], labId: "lab-a" };
const OP = { subject: "persona:operator", name: "Omar", roles: ["operator"], labId: "lab-a" };
const AP = { subject: "persona:approver", name: "Ana", roles: ["approver"], labId: "lab-a" };
const VIEW = { subject: "persona:viewer", name: "Vera", roles: ["viewer"], labId: "lab-a" };
const tmp = () => mkdtempSync(join(tmpdir(), "twin-rd-"));

const good = (id, extra = []) => ({ id, ok: true, role: id.endsWith("1") ? "write" : "verify", checks: [{ name: "the intent and job id survived task replacement", pass: true }, { name: "a replacement task still cannot record a second intent", pass: true }, ...extra] });
const fakeRunner = (kind, tasks) => ({ kind, run: async () => ({ tasks: typeof tasks === "function" ? tasks() : tasks }) });

function make({ runner = null, deploymentId = "dep-1", file = null } = {}) {
  const dir = tmp();
  const operations = { preflight: async () => ({ ok: false, code: "x" }), roundTrip: () => ({ state: "not_started" }), preflightKey: async () => null };
  return { r: createReadiness({ deploymentId, storageRunner: runner, operations, audit: createAudit({ file: join(dir, "a.jsonl") }), file }), dir, operations };
}

// ---- storage
test("storage: only admins start it, and a viewer can read the result", async () => {
  const { r } = make({ runner: fakeRunner("ecs-efs", [good("task-1"), good("task-2")]) });
  assert.equal((await r.runStorageCheck(OP)).code, "forbidden");
  assert.equal((await r.runStorageCheck(VIEW)).code, "forbidden");
  assert.equal((await r.state(VIEW, [])).storage.status, "not_run");
  assert.equal((await r.runStorageCheck(ADMIN)).ok, true);
  assert.equal((await r.state(VIEW, [])).storage.status, "verified");
});

test("storage: verified needs two separate tasks, the second recovering the job id and refusing a second intent, on a deployed volume", async () => {
  const run = async (kind, tasks) => { const { r } = make({ runner: fakeRunner(kind, tasks) }); await r.runStorageCheck(ADMIN); return (await r.state(ADMIN, [])).storage; };
  const ok = await run("ecs-efs", [good("task-1"), good("task-2")]);
  assert.equal(ok.status, "verified");
  assert.deepEqual(ok.tasks.map((t) => t.id), ["task-1", "task-2"], "the panel shows the task ids");
  assert.equal(ok.simulated, false);

  const noRecovery = await run("ecs-efs", [good("task-1"), { ...good("task-2"), checks: [{ name: "the intent and job id survived task replacement", pass: false }, { name: "a replacement task still cannot record a second intent", pass: true }] }]);
  assert.equal(noRecovery.status, "failed");
  const acceptsSecond = await run("ecs-efs", [good("task-1"), { ...good("task-2"), checks: [{ name: "the intent and job id survived task replacement", pass: true }, { name: "a replacement task still cannot record a second intent", pass: false }] }]);
  assert.equal(acceptsSecond.status, "failed");
  assert.equal((await run("ecs-efs", [good("task-1"), good("task-1")])).status, "failed", "the same task twice is not a replacement");
  assert.equal((await run("ecs-efs", [good("task-1")])).status, "failed", "one task is not two");
  assert.equal((await run("ecs-efs", [{ ...good("task-1"), ok: false }, good("task-2")])).status, "failed");
});

test("storage: a local-directory run is simulated and is never reported as verified storage", async () => {
  const { r } = make({ runner: createLocalStorageRunner() });
  await r.runStorageCheck(ADMIN);
  const st = (await r.state(ADMIN, [])).storage;
  assert.equal(st.status, "simulated_only");
  assert.equal(st.simulated, true);
  assert.match(st.detail, /not evidence about the deployed volume/);
});

test("storage: no runner, a runner that throws, and overlapping runs are handled; a changed deployment makes the result stale", async () => {
  assert.equal((await make().r.runStorageCheck(ADMIN)).code, "runner_not_configured");
  assert.match((await make().r.state(ADMIN, [])).storage.detail, /No storage check runner is configured/);
  const boom = make({ runner: { kind: "ecs-efs", run: async () => { throw new Error("aws"); } } });
  await boom.r.runStorageCheck(ADMIN);
  assert.equal((await boom.r.state(ADMIN, [])).storage.status, "failed");

  let release;
  const slow = make({ runner: { kind: "ecs-efs", run: () => new Promise((res) => { release = () => res({ tasks: [good("task-1"), good("task-2")] }); }) } });
  const first = slow.r.runStorageCheck(ADMIN);
  while (!release) await new Promise((r) => setImmediate(r));
  assert.equal((await slow.r.runStorageCheck(ADMIN)).code, "already_running");
  release(); await first;

  const file = join(tmp(), "readiness.json");
  const a = make({ runner: fakeRunner("ecs-efs", [good("task-1"), good("task-2")]), file });
  await a.r.runStorageCheck(ADMIN);
  const b = make({ runner: fakeRunner("ecs-efs", []), deploymentId: "dep-2", file });
  const stale = (await b.r.state(ADMIN, [])).storage;
  assert.equal(stale.status, "stale");
  const same = make({ runner: null, deploymentId: "dep-1", file });
  assert.equal((await same.r.state(ADMIN, [])).storage.status, "verified", "a restart of the same deployment keeps the result");
});

// ---- preflight and round trip, through the real operations service
async function service() {
  const svc = await createSimulatorService({ dir: tmp(), origin: "http://x" });
  return svc;
}
const ADDR = { name: "web", ipNetmask: "10.1.0.0/24" };

test("preflight: admin only, read-only, scoped to the principal's lab, and it never authorizes a write", async () => {
  const svc = await service();
  assert.equal((await svc.readiness.runPreflight(OP, "pan-dfw-edge")).code, "forbidden");
  assert.equal((await svc.readiness.runPreflight(ADMIN, "pan-aus-edge")).code, "target_not_available", "another lab's device");
  assert.equal((await svc.readiness.runPreflight(ADMIN, "nope")).code, "target_not_available");
  const writesBefore = svc.sim.writes;
  const r = await svc.readiness.runPreflight(ADMIN, "pan-dfw-edge");
  assert.equal(r.preflight.status, "verified");
  assert.equal(r.preflight.simulated, true);
  assert.deepEqual(r.preflight.notExercised, ["commit submission reply", "commit job status reply"]);
  assert.equal(svc.sim.writes, writesBefore);
  // A green preflight authorizes nothing: an unapproved plan still cannot execute.
  const plan = await svc.operations.request(OP, { targetId: "pan-dfw-edge", changeType: "address-object.create", params: ADDR });
  assert.equal((await svc.operations.execute(OP, plan.operation.id)).code, "not_approved");
});

test("preflight: a device that does not match inventory fails, and a repointed alias makes the old result stale", async () => {
  const svc = await service();
  svc.sim.mismatch.add("019801234560");
  assert.equal((await svc.readiness.runPreflight(ADMIN, "pan-dfw-edge")).preflight.status, "failed");
  svc.sim.mismatch.clear();
  await svc.readiness.runPreflight(ADMIN, "pan-dfw-edge");
  assert.equal((await svc.readiness.state(ADMIN, ["pan-dfw-edge"])).targets[0].preflight.status, "verified");

  // The same alias resolving to a different scope: build a second readiness view over a resolver that was repointed.
  const inventory = new Map(SIMULATOR_TARGETS);
  const { adapters } = createSimulatedAdapters();
  const dir = tmp();
  const resolver = { mode: "simulator", resolve: (a, c) => createTargetResolver({ mode: "simulator", targets: inventory }).resolve(a, c), aliases: () => [...inventory.keys()], inspect: (a) => createTargetResolver({ mode: "simulator", targets: inventory }).inspect(a) };
  const operations = createOperations({ resolver, policy: createLabPolicy({ "lab-a": { members: [OP.subject, ADMIN.subject], aliases: ["pan-dfw-edge"] } }), adapters, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "simulator" });
  const readiness = createReadiness({ deploymentId: "d", operations, audit: createAudit({ file: join(dir, "b.jsonl") }) });
  await readiness.runPreflight(ADMIN, "pan-dfw-edge");
  assert.equal((await readiness.state(ADMIN, ["pan-dfw-edge"])).targets[0].preflight.status, "verified");
  inventory.set("pan-dfw-edge", SIMULATOR_TARGETS.get("pan-aus-edge"));
  assert.equal((await readiness.state(ADMIN, ["pan-dfw-edge"])).targets[0].preflight.status, "stale");
});

test("round trip: shown only after a verified create and a freshly planned, separately approved destroy, each through the normal flow", async () => {
  const svc = await service();
  const state = async () => (await svc.readiness.state(ADMIN, ["pan-dfw-edge"])).targets[0].roundTrip;
  assert.equal((await state()).state, "not_started");
  const c = await svc.operations.request(OP, { targetId: "pan-dfw-edge", changeType: "address-object.create", params: ADDR });
  await svc.operations.decide(AP, c.operation.id, { decision: "approve", planDigest: c.operation.planDigest });
  assert.equal((await state()).state, "not_started", "approved but not yet executed");
  await svc.operations.execute(OP, c.operation.id);
  assert.equal((await state()).state, "create_verified_destroy_pending");
  const d = await svc.operations.rollback(OP, c.operation.id);
  assert.equal(d.operation.status, "pending_approval", "the destroy is a fresh plan that needs its own approval");
  assert.equal((await state()).state, "create_verified_destroy_pending");
  await svc.operations.decide(AP, d.operation.id, { decision: "approve", planDigest: d.operation.planDigest });
  await svc.operations.execute(OP, d.operation.id);
  const done = await state();
  assert.equal(done.state, "verified");
  assert.equal(done.createId, c.operation.id);
  assert.equal(done.destroyId, d.operation.id);
  // Another lab sees nothing of it.
  const other = await svc.readiness.state({ ...ADMIN, subject: "persona:approver-b", labId: "lab-b" }, ["pan-dfw-edge"]);
  assert.equal(other.targets[0].roundTrip.state, "not_started");
});

test("the readiness module has no way to provision storage, edit targets, approve, execute, or retry", async () => {
  const svc = await service();
  assert.deepEqual(Object.keys(svc.readiness).sort(), ["ready", "runPreflight", "runStorageCheck", "state"]);
  assert.equal(svc.operations.retry, undefined);
  assert.equal(svc.operations.retryCommit, undefined);
});

test("round trip: a completed round trip stops counting if the alias is repointed at another device", async () => {
  const inventory = new Map(SIMULATOR_TARGETS);
  const { adapters } = createSimulatedAdapters();
  const dir = tmp();
  const resolver = { mode: "simulator", resolve: (a, c) => createTargetResolver({ mode: "simulator", targets: inventory }).resolve(a, c), aliases: () => [...inventory.keys()], inspect: (a) => createTargetResolver({ mode: "simulator", targets: inventory }).inspect(a) };
  const operations = createOperations({ resolver, policy: createLabPolicy({ "lab-a": { members: [OP.subject, AP.subject, ADMIN.subject], aliases: ["pan-dfw-edge"] } }), adapters, audit: createAudit({ file: join(dir, "a.jsonl") }), transportKind: "simulator" });
  const readiness = createReadiness({ deploymentId: "d", operations, audit: createAudit({ file: join(dir, "b.jsonl") }) });
  const c = await operations.request(OP, { targetId: "pan-dfw-edge", changeType: "address-object.create", params: ADDR });
  await operations.decide(AP, c.operation.id, { decision: "approve", planDigest: c.operation.planDigest });
  await operations.execute(OP, c.operation.id);
  const d = await operations.rollback(OP, c.operation.id);
  await operations.decide(AP, d.operation.id, { decision: "approve", planDigest: d.operation.planDigest });
  await operations.execute(OP, d.operation.id);
  assert.equal((await readiness.state(ADMIN, ["pan-dfw-edge"])).targets[0].roundTrip.state, "verified");
  inventory.set("pan-dfw-edge", SIMULATOR_TARGETS.get("pan-aus-edge"));
  assert.equal((await readiness.state(ADMIN, ["pan-dfw-edge"])).targets[0].roundTrip.state, "not_started");
});
