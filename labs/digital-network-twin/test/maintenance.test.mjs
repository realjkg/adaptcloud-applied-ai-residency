import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTest, playwright } from "./browser.mjs";
import { createSimulatorService } from "../server/learner.mjs";
import { createMaintenance } from "../server/scenarios/maintenance.mjs";
import { createAudit } from "../server/audit.mjs";
import { createLabPolicy } from "../server/target-resolution.mjs";
import { answerFor, FIXTURES, fixturesDigest } from "../server/scenarios/maintenance-fixtures.mjs";
import { compare, evaluatePool, judge, poolState, sendString, validateMonitor } from "../server/scenarios/monitor-model.mjs";

const here = (p) => new URL(`../server/scenarios/${p}`, import.meta.url);
const GOOD = { path: "/health", receive: "200" };
const NEXT = { path: "/healthz", receive: "200" };

// ---- the decision rules, with no fixtures in sight
test("monitor model: a member is healthy only if it answers with a successful status and the expected text", () => {
  const m = { path: "/health", receive: "ok" };
  assert.deepEqual(judge(m, { status: 200, body: "ok" }), { path: "/health", answered: true, status: 200, matched: true, healthy: true, reason: "expected_response" });
  assert.equal(judge(m, { status: 200, body: "fine" }).reason, "expected_text_missing");
  assert.equal(judge(m, { status: 503, body: "ok" }).reason, "unsuccessful_status", "the text matching is not enough on a failing status");
  assert.equal(judge(m, { status: 404, body: "not found" }).healthy, false);
  assert.equal(judge(m, null).reason, "no_response");
  assert.equal(judge({ path: "/", receive: "200" }, { status: 200, body: "x" }).healthy, true, "the status code itself can be the expectation");
  assert.equal(judge({ path: "/", receive: "404" }, { status: 404, body: "x" }).healthy, false, "a matching but failing status is still unhealthy");
});

test("monitor model: pool state is available, degraded, or offline, and an empty pool is never available", () => {
  const r = (...h) => h.map((healthy) => ({ probe: { healthy } }));
  assert.deepEqual(poolState(r(true, true)), { healthy: 2, total: 2, state: "available" });
  assert.equal(poolState(r(true, false)).state, "degraded");
  assert.equal(poolState(r(false, false)).state, "offline");
  assert.equal(poolState([]).state, "offline");
});

test("monitor model: submitted monitors are structured and cannot carry line breaks, spaces, or extra headers into the probe", () => {
  assert.deepEqual(validateMonitor(GOOD), []);
  for (const bad of [{ path: "health", receive: "200" }, { path: "/a b", receive: "200" }, { path: "/a\r\nX-Evil: 1", receive: "200" }, { path: "/a?x=1", receive: "200" }, { path: "/".padEnd(80, "a"), receive: "200" }, { path: "/ok", receive: "" }, { path: "/ok", receive: "a\nb" }, { path: "/ok" }, null, [], "x"]) assert.ok(validateMonitor(bad).length > 0, JSON.stringify(bad));
  assert.equal(sendString(GOOD, "app.lab.example"), "GET /health HTTP/1.1\r\nHost: app.lab.example\r\nConnection: close\r\n\r\n");
});

// ---- the fixtures
test("fixtures are static: no clock (beyond the injected default), randomness in the data, timers, sockets, process environment, or network in any scenario file", () => {
  for (const f of ["monitor-model.mjs", "maintenance-fixtures.mjs", "maintenance.mjs"]) {
    const src = readFileSync(here(f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace("now = () => new Date()", "now = INJECTED_CLOCK");
    for (const re of [/Math\.random/, /\bnew Date\(\)/, /Date\.now/, /\bsetTimeout|\bsetInterval|setImmediate/, /\bfetch\s*\(/, /node:(net|http|https|tls|dns|child_process)/, /process\.env/, /crypto\.random|randomUUID/]) {
      assert.ok(!re.test(src), `${f} matches ${re}`);
    }
  }
  const model = readFileSync(here("monitor-model.mjs"), "utf8");
  assert.ok(!/import .*fixtures/i.test(model), "the decision rules know nothing about where observations come from");
});

test("fixtures are deterministic and frozen, and tell the story the scenario is built on", () => {
  const eval1 = JSON.stringify(evaluatePool(NEXT, FIXTURES.members, answerFor));
  const eval2 = JSON.stringify(evaluatePool(NEXT, FIXTURES.members, answerFor));
  assert.equal(eval1, eval2);
  assert.ok(Object.isFrozen(FIXTURES) && Object.isFrozen(FIXTURES.members[0]) && Object.isFrozen(FIXTURES.members[0].endpoints));
  assert.equal(fixturesDigest(), fixturesDigest());
  const good = evaluatePool(GOOD, FIXTURES.members, answerFor);
  assert.equal(good.state, "available");
  const next = evaluatePool(NEXT, FIXTURES.members, answerFor);
  assert.equal(next.state, "degraded");
  assert.deepEqual(compare(good, next).filter((c) => c.changed).map((c) => [c.id, c.after, c.status]), [["app-2", "unhealthy", 404]]);
  assert.equal(evaluatePool({ path: "/ready", receive: "ready" }, FIXTURES.members, answerFor).members[1].probe.reason, "unsuccessful_status");
  assert.equal(answerFor({ ...FIXTURES.members[0], down: true }, "/health"), null);
});

// ---- the service: plans, freshness, once, restore, isolation
const A = { subject: "persona:operator", name: "Omar", roles: ["operator"], labId: "lab-a" };
const AV = { subject: "persona:viewer", name: "Vera", roles: ["viewer"], labId: "lab-a" };
const B = { subject: "persona:operator-b", name: "Olga", roles: ["operator"], labId: "lab-b" };
const policy = createLabPolicy({ "lab-a": { members: [A.subject, AV.subject], aliases: [] }, "lab-b": { members: [B.subject], aliases: [] } });
function make(over = {}) {
  const clock = { t: Date.parse("2026-11-19T10:00:00Z") };
  const svc = createMaintenance({ access: policy, audit: createAudit({ file: join(mkdtempSync(join(tmpdir(), "twin-mt-")), "a.jsonl"), now: () => new Date(clock.t) }), now: () => new Date(clock.t), ...over });
  return { svc, clock };
}

test("service: planning previews the effect and writes nothing; deploying verifies the observed pool against the prediction", async () => {
  const { svc } = make();
  const start = svc.get(A);
  assert.equal(start.desired.revision, 1);
  assert.equal(start.observed.state, "available");
  const p = await svc.plan(A, { monitor: NEXT });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.plan.predicted.state, "degraded");
  assert.deepEqual(p.plan.change.filter((c) => c.changed).map((c) => c.id), ["app-2"]);
  assert.deepEqual(svc.get(A).desired, start.desired, "planning changed nothing");
  assert.equal(svc.get(A).revisions.length, 1);

  const d = await svc.deploy(A, p.plan.id);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.plan.result.revision, 2);
  assert.equal(d.plan.result.matchedPrediction, true);
  const after = svc.get(A);
  assert.equal(after.desired.revision, 2);
  assert.equal(after.observed.state, "degraded", "observed state is computed from the fixtures, separately from the desired monitor");
  assert.equal(after.knownGoodRevision, 1);
  assert.deepEqual(after.revisions.map((r) => [r.rev, r.poolState]), [[1, "available"], [2, "degraded"]]);
});

test("service: restoring a known-good revision plans a new revision and never rewrites history", async () => {
  const { svc } = make();
  await svc.deploy(A, (await svc.plan(A, { monitor: NEXT })).plan.id);
  const rp = await svc.plan(A, { restoreRevision: 1 });
  assert.equal(rp.plan.kind, "restore");
  assert.equal(rp.plan.restoreOf, 1);
  assert.equal(rp.plan.predicted.state, "available");
  assert.equal(svc.get(A).desired.revision, 2, "a restore plan changes nothing until it is deployed");
  const d = await svc.deploy(A, rp.plan.id);
  assert.equal(d.plan.result.revision, 3);
  const s = svc.get(A);
  assert.deepEqual(s.revisions.map((r) => [r.rev, r.source, r.restoreOf, r.poolState]), [[1, "initial", null, "available"], [2, "deploy", null, "degraded"], [3, "restore", 1, "available"]]);
  assert.deepEqual(s.desired.monitor, s.revisions[0].monitor);
  assert.equal((await svc.plan(A, { restoreRevision: 3 })).code, "already_current");
  assert.equal((await svc.plan(A, { restoreRevision: 9 })).code, "revision_not_found");
  assert.equal((await svc.plan(A, { monitor: GOOD })).code, "no_change");
  assert.equal((await svc.plan(A, { monitor: { path: "/a b", receive: "200" } })).code, "monitor_invalid");
});

test("service: a plan is refused as stale if the lab moved on or the fixtures changed, and a retry or concurrent deploy writes once", async () => {
  const { svc } = make();
  const one = (await svc.plan(A, { monitor: NEXT })).plan;
  const two = (await svc.plan(A, { monitor: { path: "/ready", receive: "ready" } })).plan;
  const [x, y] = await Promise.all([svc.deploy(A, one.id), svc.deploy(A, one.id)]);
  assert.ok(x.ok && y.ok);
  assert.equal(svc.get(A).revisions.length, 2, "two concurrent deploys, one revision");
  const again = await svc.deploy(A, one.id);
  assert.equal(again.existing, true);
  assert.equal(svc.get(A).revisions.length, 2);
  const late = await svc.deploy(A, two.id);
  assert.equal(late.code, "stale_plan_new_plan_required");
  assert.equal(svc.get(A).revisions.length, 2, "the stale plan wrote nothing");
  assert.equal((await svc.deploy(A, two.id)).code, "already_stale");

  const members = FIXTURES.members.map((m) => ({ ...m, endpoints: { ...m.endpoints } }));
  const live = { ...FIXTURES, members };
  const { svc: s2 } = make({ fixtures: live });
  const p = (await s2.plan(A, { monitor: NEXT })).plan;
  members[0].down = true;
  assert.equal((await s2.deploy(A, p.id)).code, "stale_plan_new_plan_required", "the backends changed after the preview");
  assert.equal(s2.get(A).revisions.length, 1);
});

test("service: plans expire, the kill switch stops planning and deploying, and roles are enforced", async () => {
  const { svc, clock } = make();
  const p = (await svc.plan(A, { monitor: NEXT })).plan;
  clock.t += 31 * 60_000;
  assert.equal((await svc.deploy(A, p.id)).code, "plan_expired");
  assert.equal(svc.get(A).revisions.length, 1);
  let kill = false;
  const { svc: k } = make({ killSwitch: () => kill });
  const kp = (await k.plan(A, { monitor: NEXT })).plan;
  kill = true;
  assert.equal((await k.deploy(A, kp.id)).code, "kill_switch_engaged");
  assert.equal((await k.plan(A, { monitor: NEXT })).code, "kill_switch_engaged");
  assert.equal((await svc.plan(AV, { monitor: NEXT })).code, "forbidden");
  assert.equal(svc.get(AV).desired.revision, 1, "a viewer can read");
  assert.equal(svc.get({ ...A, labId: null }), null);
  assert.equal(svc.get({ ...A, subject: "stranger" }), null);
});

test("service: labs have separate revisions, and another lab's plan answers exactly like an unknown plan", async () => {
  const { svc } = make();
  const p = (await svc.plan(A, { monitor: NEXT })).plan;
  const foreign = await svc.deploy(B, p.id);
  const unknown = await svc.deploy(B, "PLN-0000000000");
  assert.deepEqual(foreign, unknown);
  assert.equal(foreign.code, "not_found");
  assert.equal(svc.getPlan(B, p.id), null);
  assert.equal(svc.get(A).revisions.length, 1, "nothing happened to lab A's plan");
  await svc.deploy(A, p.id);
  assert.equal(svc.get(A).desired.revision, 2);
  assert.equal(svc.get(B).desired.revision, 1, "lab B is untouched");
  assert.equal(svc.get(B).observed.state, "available");
});

// ---- over HTTP, and in a browser
async function serve() {
  let base = "";
  const svc = await createSimulatorService({ dir: mkdtempSync(join(tmpdir(), "twin-mt-")), origin: () => base });
  await new Promise((r) => svc.app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${svc.app.address().port}`;
  const client = async (persona) => {
    const st = { cookie: "", csrf: "" };
    const call = async (method, path, payload) => {
      const res = await fetch(base + path, { method, headers: { origin: base, ...(st.cookie ? { cookie: st.cookie } : {}), ...(st.csrf ? { "x-csrf-token": st.csrf } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body, headers: res.headers };
    };
    const r = await call("POST", "/auth/persona", { persona });
    st.cookie = r.headers.get("set-cookie").split(";")[0];
    st.csrf = (await call("GET", "/api/me")).body.csrf;
    return { call };
  };
  return { svc, base, client, close: () => svc.app.close() };
}

test("HTTP: the scenario routes need a session and the right role, are CSRF protected, and never leak another lab's plan", async () => {
  const t = await serve();
  try {
    const anon = await fetch(`${t.base}/api/scenarios/maintenance`);
    assert.equal(anon.status, 401);
    const viewer = await t.client("viewer"); const op = await t.client("operator"); const opB = await t.client("operator-b");
    const state = await viewer.call("GET", "/api/scenarios/maintenance");
    assert.equal(state.status, 200);
    assert.equal(state.body.desired.revision, 1);
    assert.equal(state.body.observed.state, "available");
    assert.equal((await viewer.call("POST", "/api/scenarios/maintenance/plan", { monitor: NEXT })).status, 403);
    const plan = await op.call("POST", "/api/scenarios/maintenance/plan", { monitor: NEXT });
    assert.equal(plan.status, 201);
    assert.equal(plan.body.plan.predicted.state, "degraded");
    assert.equal((await op.call("POST", "/api/scenarios/maintenance/plan", { monitor: { path: "/x y", receive: "200" } })).status, 422);
    const id = plan.body.plan.id;
    const foreign = await opB.call("POST", "/api/scenarios/maintenance/deploy", { planId: id });
    assert.deepEqual(foreign, await opB.call("POST", "/api/scenarios/maintenance/deploy", { planId: "PLN-0000000000" }));
    assert.equal(foreign.status, 404);
    assert.equal((await opB.call("GET", `/api/scenarios/maintenance/plans/${id}`)).status, 404);
    assert.equal((await viewer.call("POST", "/api/scenarios/maintenance/deploy", { planId: id })).status, 403);
    const bad = await fetch(`${t.base}/api/scenarios/maintenance/deploy`, { method: "POST", headers: { origin: t.base, cookie: "sid=x", "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 401);
    const done = await op.call("POST", "/api/scenarios/maintenance/deploy", { planId: id });
    assert.equal(done.status, 200);
    assert.equal((await op.call("POST", "/api/scenarios/maintenance/deploy", { planId: id })).body.existing, true);
    assert.equal((await op.call("GET", "/api/scenarios/maintenance")).body.observed.state, "degraded");
    assert.equal((await opB.call("GET", "/api/scenarios/maintenance")).body.observed.state, "available", "lab B is unaffected");
    assert.equal((await op.call("POST", "/api/scenarios/maintenance/plan", { restoreRevision: 1 })).status, 201);
  } finally { t.close(); }
});

browserTest("in a browser: preview names the member a monitor change would drop, deploy shows the observed pool, restore brings it back, and another lab is unaffected", async () => {
  const t = await serve();
  const browser = await playwright.chromium.launch();
  try {
    const errors = [];
    const open = async (persona) => {
      const page = await (await browser.newContext()).newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|404|409|422)/.test(m.text())) errors.push(m.text()); });
      await page.goto(t.base);
      await page.locator(`[data-persona="${persona}"]`).click();
      await page.waitForSelector("#maintenance:not([hidden]) [data-field='observed']");
      return page;
    };
    const viewer = await open("viewer");
    assert.match(await viewer.locator("[data-field='observed']").textContent(), /available \(2 of 2 members healthy\)/);
    assert.equal(await viewer.locator("[data-action='preview']").count(), 0, "a viewer sees no controls");

    const a = await open("operator");
    await a.locator("#maintenance [name='path']").fill("/healthz");
    // A background session refresh must not throw away what the person typed.
    await a.evaluate(() => document.querySelector("#operate-root").append(document.createElement("span")));
    await a.waitForTimeout(400);
    assert.equal(await a.locator("#maintenance [name='path']").inputValue(), "/healthz");
    await a.locator("[data-action='preview']").click();
    await a.waitForSelector("[data-field='plan']");
    const plan = await a.locator("[data-field='plan']").textContent();
    assert.match(plan, /predicted pool degraded \(1 of 2 members healthy\)/);
    assert.match(await a.locator("[data-changed='app-2']").textContent(), /app-2: healthy to unhealthy \(unsuccessful status, status 404\)/);
    assert.match(await a.locator("[data-field='observed']").textContent(), /available/, "previewing changed nothing");

    await a.locator("[data-action='deploy']").click();
    await a.waitForFunction(() => /degraded \(1 of 2 members healthy\)/.test(document.querySelector("[data-field='observed']").textContent));
    assert.match(await a.locator("[data-field='desired']").textContent(), /Deployed revision 2: GET \/healthz/);
    assert.equal(await a.locator("[data-revision]").count(), 2);

    await a.locator("[data-revision='1'] [data-action='restore']").click();
    await a.waitForSelector("[data-field='plan']");
    assert.match(await a.locator("[data-field='plan']").textContent(), /\(restore\)/);
    await a.locator("[data-action='deploy']").click();
    await a.waitForFunction(() => /available \(2 of 2 members healthy\)/.test(document.querySelector("[data-field='observed']").textContent));
    assert.equal(await a.locator("[data-revision]").count(), 3, "history is kept and extended");

    const b = await open("operator-b");
    assert.equal(await b.locator("[data-revision]").count(), 1, "lab B never saw lab A's revisions");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); t.close(); }
});
