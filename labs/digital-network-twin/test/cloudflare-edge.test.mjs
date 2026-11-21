import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardedHttp } from "../tools/live/guarded-http.mjs";
import { createCloudflareEdgeAdapter } from "../server/adapters/cloudflare.mjs";
import { CHANGE_TYPES, buildExpression, planEdge } from "../server/adapters/cloudflare-plan.mjs";
import { createSimulatorService } from "../server/learner.mjs";
import { createOperations } from "../server/operations.mjs";
import { createAudit } from "../server/audit.mjs";
import { SIMULATOR_TARGETS } from "../server/simulator-targets.mjs";
import { createLivePolicy, createTargetResolver, TargetError } from "../server/target-resolution.mjs";
import { loadTargets } from "../server/targets.mjs";

const COND = { conditionField: "path", conditionOp: "starts_with", conditionValue: "/admin" };
const WAF = { ...COND, action: "block", comment: "incident 42" };
const OPR = { subject: "persona:operator", name: "Omar", roles: ["operator"], labId: "lab-a" };
const APR = { subject: "persona:approver", name: "Ana", roles: ["approver"], labId: "lab-a" };
const OPB = { subject: "persona:operator-b", name: "Olga", roles: ["operator"], labId: "lab-b" };
const tmp = () => mkdtempSync(join(tmpdir(), "twin-cf-"));

// ---- planning
test("conditions are closed lists, values cannot carry quotes, spaces, or backslashes, and the expression is built from validated parts", () => {
  const v = CHANGE_TYPES["waf-custom-rule.add"].validate;
  assert.deepEqual(v(WAF), []);
  for (const bad of ['/a" or true or "', "/a b", "/a\\b", "/x)) or (http.host ne \"", "admin"]) assert.ok(v({ ...WAF, conditionValue: bad }).length > 0, bad);
  assert.ok(v({ ...WAF, conditionField: "raw" }).length > 0);
  assert.ok(v({ ...WAF, conditionField: "host", conditionOp: "contains", conditionValue: "a.test" }).length > 0, "operator not allowed for that field");
  assert.ok(v({ ...WAF, conditionField: "ip", conditionOp: "in", conditionValue: "300.1.1.1" }).length > 0);
  assert.ok(v({ ...WAF, action: "execute" }).length > 0, "no managed-ruleset execute or skip actions");
  assert.equal(buildExpression(WAF), '(starts_with(http.request.uri.path, "/admin"))');
  assert.equal(buildExpression({ conditionField: "ip", conditionOp: "in", conditionValue: "203.0.113.0/24" }), "(ip.src in {203.0.113.0/24})");
  const r = CHANGE_TYPES["redirect-rule.add"].validate;
  const base = { ...COND, targetUrl: "https://new.shop.test/contact", statusCode: "302", preserveQuery: "no", comment: "move" };
  assert.deepEqual(r(base), []);
  for (const bad of ["http://x.test", "https://x.test/a b", "javascript:alert(1)", "https://user@x.test"]) assert.ok(r({ ...base, targetUrl: bad }).length > 0, bad);
  assert.ok(CHANGE_TYPES["cache-rule.add"].validate({ ...COND, cacheMode: "bypass", edgeTtl: "60", comment: "x" }).length > 0, "a TTL only goes with eligible");
});

test("names a browser supplies are looked up as own properties only: constructor, __proto__, and friends are validation errors, never crashes", () => {
  const v = CHANGE_TYPES["waf-custom-rule.add"].validate;
  for (const field of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", 7, null, undefined, ["host"], { host: 1 }]) {
    let result; assert.doesNotThrow(() => { result = v({ ...WAF, conditionField: field }); }, String(field));
    assert.ok(result.length > 0, `${String(field)} must be a validation error`);
  }
});

test("the plan adds one rule, leaves every other rule unchanged, previews the effect on synthetic traffic, and needs no exclusive window", () => {
  const state = { exists: true, rulesetId: "r1", version: 4, rules: [{ id: "x1", ref: "legacy", description: "theirs", action: "block", expression: '(ip.src.country eq "XX")', enabled: true }] };
  const p = planEdge({ changeType: "waf-custom-rule.add", params: WAF, state, opId: "OP-ABCDEF0123" });
  assert.equal(p.phase, "http_request_firewall_custom");
  assert.equal(p.proposed.rules.length, 2);
  assert.equal(p.proposed.rules[0].ref, "legacy");
  assert.equal(p.proposed.rules[1].ref, "twin-op-abcdef0123");
  assert.match(p.proposed.rules[1].description, /^twin-op:OP-ABCDEF0123 /);
  assert.equal(p.diff.unrelatedRulesUnchanged, true);
  assert.equal(p.requiresExclusiveWindow, false);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.preview.kind, "synthetic_traffic_sample");
  assert.equal(p.preview.matched, 2);
  assert.match(p.preview.note, /not real traffic/);
  assert.equal(p.preview.existingRulesNotEvaluated, 1);
  assert.ok(planEdge({ changeType: "waf-custom-rule.add", params: WAF, state: { exists: true, rulesetId: "r1", version: 5, rules: p.proposed.rules }, opId: "OP-ABCDEF0123" }).blockers.includes("rule_ref_already_exists"));
  const redirect = planEdge({ changeType: "redirect-rule.add", params: { conditionField: "host", conditionOp: "eq", conditionValue: "old.shop.test", targetUrl: "https://www.shop.test/", statusCode: "301", preserveQuery: "yes", comment: "retire host" }, state: { exists: false, rulesetId: null, version: 0, rules: [] }, opId: "OP-0000000001" });
  assert.deepEqual(redirect.proposed.rules[0].action_parameters, { from_value: { target_url: { value: "https://www.shop.test/" }, status_code: 301, preserve_query_string: true } });
  assert.equal(redirect.preview.matched, 2);
  const cache = planEdge({ changeType: "cache-rule.add", params: { ...COND, conditionValue: "/api", cacheMode: "bypass", comment: "api" }, state, opId: "OP-0000000002" });
  assert.deepEqual(cache.proposed.rules.at(-1).action_parameters, { cache: false });
});

// ---- the simulated edge, through the normal approval workflow
test("simulated edge change: request, a different approver, execute; another administrator's rule survives; the plan shows the synthetic traffic effect", async () => {
  const svc = await createSimulatorService({ dir: tmp(), origin: "http://x" });
  const r = await svc.operations.request(OPR, { targetId: "cf-edge-a", changeType: "waf-custom-rule.add", params: WAF });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.operation.preview.matched, 2);
  assert.equal(r.operation.requiresExclusiveWindow, false);
  assert.equal(r.operation.diff.unrelatedRulesUnchanged, true);
  assert.equal(svc.sim.cfFor("1".repeat(32)).phases.http_request_firewall_custom.rules.length, 1, "planning writes nothing");
  assert.equal((await svc.operations.decide(OPR, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest })).code, "forbidden");
  assert.equal((await svc.operations.decide(APR, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest })).ok, true, "no exclusive-window confirmation is asked for");
  const done = await svc.operations.execute(OPR, r.operation.id);
  assert.equal(done.ok, true, JSON.stringify(done));
  const rules = svc.sim.cfFor("1".repeat(32)).phases.http_request_firewall_custom.rules;
  assert.deepEqual(rules.map((x) => x.ref), ["legacy-block-bots", `twin-${r.operation.id.toLowerCase()}`]);
  assert.equal(svc.sim.cfFor("2".repeat(32)).phases.http_request_firewall_custom.rules.length, 1, "lab B's zone is untouched");
  // A different phase has no entry point yet: the first rule creates it.
  const c = await svc.operations.request(OPR, { targetId: "cf-edge-a", changeType: "cache-rule.add", params: { ...COND, conditionValue: "/api", cacheMode: "bypass", comment: "api" } });
  await svc.operations.decide(APR, c.operation.id, { decision: "approve", planDigest: c.operation.planDigest });
  assert.equal((await svc.operations.execute(OPR, c.operation.id)).ok, true);
  assert.equal(svc.sim.cfFor("1".repeat(32)).phases.http_request_cache_settings.rules.length, 1);
});

test("simulated edge change: rollback is its own approved change, refused if the rule was edited, and a lost reply is verified before any retry", async () => {
  const svc = await createSimulatorService({ dir: tmp(), origin: "http://x" });
  const Z = svc.sim.cfFor("1".repeat(32));
  const run = async (params, mode) => {
    const r = await svc.operations.request(OPR, { targetId: "cf-edge-a", changeType: "waf-custom-rule.add", params });
    await svc.operations.decide(APR, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest });
    if (mode) svc.sim.nextWrite = mode;
    return { id: r.operation.id, res: await svc.operations.execute(OPR, r.operation.id) };
  };
  const lost = await run(WAF, "lost");
  assert.equal(lost.res.operation.result.note, "write_response_lost_state_verified");
  assert.equal(Z.phases.http_request_firewall_custom.rules.length, 2, "verified without a second write");

  const rb = await svc.operations.rollback(OPR, lost.id);
  assert.equal(rb.operation.changeType, "edge-rule.remove");
  assert.equal(rb.operation.status, "pending_approval");
  assert.equal(Z.phases.http_request_firewall_custom.rules.length, 2, "requesting a rollback removes nothing");
  await svc.operations.decide(APR, rb.operation.id, { decision: "approve", planDigest: rb.operation.planDigest });
  assert.equal((await svc.operations.execute(OPR, rb.operation.id)).ok, true);
  assert.deepEqual(Z.phases.http_request_firewall_custom.rules.map((x) => x.ref), ["legacy-block-bots"]);

  const again = await run({ ...WAF, comment: "second" });
  Z.phases.http_request_firewall_custom.rules.find((x) => x.ref === `twin-${again.id.toLowerCase()}`).expression = '(http.host eq "evil.test")';
  assert.deepEqual((await svc.operations.rollback(OPR, again.id)).blockers, ["rule_changed_since_creation"]);

  const dropped = await run({ ...WAF, comment: "third" }, "dropped");
  assert.equal(dropped.res.operation.result.attempts, 2);
  assert.equal(dropped.res.operation.status, "completed");
});

test("simulated edge change: drift marks the plan stale, and another lab cannot name this zone", async () => {
  const svc = await createSimulatorService({ dir: tmp(), origin: "http://x" });
  const r = await svc.operations.request(OPR, { targetId: "cf-edge-a", changeType: "waf-custom-rule.add", params: WAF });
  await svc.operations.decide(APR, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest });
  svc.sim.cfFor("1".repeat(32)).phases.http_request_firewall_custom.rules.push({ id: "z", ref: "someone-new", description: "", action: "log", expression: "true", enabled: true });
  assert.equal((await svc.operations.execute(OPR, r.operation.id)).code, "drift_detected_new_plan_required");
  const writes = svc.sim.writes;
  assert.equal((await svc.operations.request(OPB, { targetId: "cf-edge-a", changeType: "waf-custom-rule.add", params: WAF })).code, "target_not_available");
  assert.equal(svc.sim.writes, writes);
  assert.deepEqual(svc.operations.targets(OPB).map((t) => t.id).sort(), ["cf-edge-b", "mx-plano-branch", "pan-aus-edge"]);
  assert.ok(!(await svc.operations.request(OPR, { targetId: "cf-edge-a", changeType: "edge-rule.remove", params: { phase: "http_request_firewall_custom", mark: "OP-0000000000" } })).ok, "removal is rollback-only");
});

// ---- the live adapter against a fake that follows the documented Rulesets API
const TOKEN = "SYNTH-CF-TOKEN";
const ZONE = "3".repeat(32);
const ACCOUNT = "4".repeat(32);
const LIVE_T = { id: "lab-cf", label: "Lab zone", vendor: "cloudflare", environment: "lab", disposable: true, host: "api.cloudflare.com", zoneId: ZONE, accountId: ACCOUNT, zoneName: "lab-zone.shopco.dev", credentialEnv: "CF_TOKEN_LAB", access: { principals: ["u-op", "u-ap"] }, changeTypes: ["waf-custom-rule.add", "redirect-rule.add", "cache-rule.add", "edge-rule.remove"] };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function fakeCloudflare({ phases = {}, zoneName = LIVE_T.zoneName, account = ACCOUNT, loseReply = false } = {}) {
  const f = { phases, calls: [], urls: [], n: 0 };
  const view = (ph, x) => ({ id: x.id, name: "entry", kind: "zone", phase: ph, version: String(x.version), rules: x.rules.map((r) => ({ version: "1", last_updated: "2026-01-01T00:00:00Z", ...r })), last_updated: "2026-01-01T00:00:00Z" });
  f.fetch = async (url, init) => {
    const u = new URL(url);
    f.calls.push(`${init.method} ${u.pathname.replace(`/client/v4/zones/${ZONE}`, "")}`); f.urls.push(url);
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return json({ success: false }, 403);
    const path = u.pathname.replace(`/client/v4/zones/${ZONE}`, "");
    if (path === "") return json({ success: true, result: { id: ZONE, name: zoneName, account: { id: account } } });
    const entry = /^\/rulesets\/phases\/([a-z_]+)\/entrypoint$/.exec(path);
    if (entry && init.method === "GET") return f.phases[entry[1]] ? json({ success: true, result: view(entry[1], f.phases[entry[1]]) }) : json({ success: false, errors: [{ code: 10003 }] }, 404);
    if (path === "/rulesets" && init.method === "POST") {
      const b = JSON.parse(init.body);
      f.phases[b.phase] = { id: `rs${++f.n}`.padEnd(32, "0"), version: 1, rules: b.rules.map((r) => ({ id: `r${++f.n}`.padEnd(32, "0"), ...r })) };
      if (loseReply) throw new TypeError("socket hang up");
      return json({ success: true, result: view(b.phase, f.phases[b.phase]) });
    }
    const rule = /^\/rulesets\/([0-9a-z]+)\/rules(?:\/([0-9a-z]+))?$/.exec(path);
    if (rule) {
      const [ph, x] = Object.entries(f.phases).find(([, v]) => v.id === rule[1]) ?? [];
      if (!x) return json({ success: false }, 404);
      if (init.method === "POST") { x.rules.push({ id: `r${++f.n}`.padEnd(32, "0"), ...JSON.parse(init.body) }); x.version += 1; if (loseReply) throw new TypeError("socket hang up"); return json({ success: true, result: view(ph, x) }); }
      if (init.method === "DELETE") { x.rules = x.rules.filter((r) => r.id !== rule[2]); x.version += 1; return json({ success: true, result: view(ph, x) }); }
    }
    return json({ success: false }, 404);
  };
  return f;
}
const FOREIGN = { id: "f".repeat(32), ref: "theirs", description: "someone else's rule", action: "block", expression: '(ip.src.country eq "XX")', enabled: true };

function liveOps(f) {
  const http = createGuardedHttp({ allowedHosts: ["api.cloudflare.com"], fetchImpl: f.fetch });
  return createOperations({
    resolver: createTargetResolver({ mode: "live", targets: new Map([[LIVE_T.id, LIVE_T]]), fixtures: SIMULATOR_TARGETS }),
    policy: createLivePolicy({ [LIVE_T.id]: LIVE_T.access.principals }),
    adapters: { cloudflare: createCloudflareEdgeAdapter({ http, target: LIVE_T, env: { CF_TOKEN_LAB: TOKEN } }) },
    audit: createAudit({ file: join(tmp(), "a.jsonl") }), transportKind: "live", liveAuthorized: () => true
  });
}
const LOP = { subject: "u-op", name: "Op", roles: ["operator"], labId: "live" };
const LAP = { subject: "u-ap", name: "Ap", roles: ["approver"], labId: "live" };
const go = async (ops, params, type = "waf-custom-rule.add") => {
  const r = await ops.request(LOP, { targetId: "lab-cf", changeType: type, params });
  assert.equal(r.ok, true, JSON.stringify(r));
  await ops.decide(LAP, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest });
  return { id: r.operation.id, done: await ops.execute(LOP, r.operation.id) };
};
const writes = (f) => f.calls.filter((c) => c.startsWith("POST") || c.startsWith("DELETE")).length;

test("Cloudflare live: a rule is added with one POST, other rules are untouched, the token is a header only, and the rules are read back", async () => {
  const f = fakeCloudflare({ phases: { http_request_firewall_custom: { id: "a".repeat(32), version: 7, rules: [FOREIGN] } } });
  const { done } = await go(liveOps(f), WAF);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(f.phases.http_request_firewall_custom.rules.map((r) => r.ref), ["theirs", done.operation.id ? `twin-${done.operation.id.toLowerCase()}` : ""]);
  assert.deepEqual(f.phases.http_request_firewall_custom.rules[0], FOREIGN);
  assert.equal(writes(f), 1);
  assert.ok(f.calls.includes(`POST /rulesets/${"a".repeat(32)}/rules`));
  assert.ok(f.urls.every((u) => !u.includes(TOKEN)));
  assert.equal(f.phases.http_request_firewall_custom.version, 8);
});

test("Cloudflare live: a phase with no entry point (404) is created by one POST that carries the rule, and the rule round-trips for redirect and cache", async () => {
  const f = fakeCloudflare();
  const ops = liveOps(f);
  const redirect = await go(ops, { conditionField: "host", conditionOp: "eq", conditionValue: "old.shop.test", targetUrl: "https://www.shop.test/", statusCode: "301", preserveQuery: "no", comment: "retire" }, "redirect-rule.add");
  assert.equal(redirect.done.ok, true, JSON.stringify(redirect.done));
  assert.ok(f.calls.includes("POST /rulesets"));
  assert.equal(f.phases.http_request_dynamic_redirect.rules[0].action, "redirect");
  const cache = await go(ops, { ...COND, conditionValue: "/api", cacheMode: "eligible", edgeTtl: "300", comment: "api ttl" }, "cache-rule.add");
  assert.equal(cache.done.ok, true, JSON.stringify(cache.done));
  assert.deepEqual(f.phases.http_request_cache_settings.rules[0].action_parameters, { cache: true, edge_ttl: { mode: "override_origin", default: 300 } });
});

test("Cloudflare live: a lost reply is verified by reading, not replayed; rollback deletes only our rule and is a separate approval", async () => {
  const f = fakeCloudflare({ phases: { http_request_firewall_custom: { id: "a".repeat(32), version: 7, rules: [FOREIGN] } }, loseReply: true });
  const ops = liveOps(f);
  const { id, done } = await go(ops, WAF);
  assert.equal(done.operation.result.note, "write_response_lost_state_verified");
  assert.equal(writes(f), 1);
  const rb = await ops.rollback(LOP, id);
  assert.equal(rb.operation.status, "pending_approval");
  assert.equal(writes(f), 1, "requesting a rollback deletes nothing");
  await ops.decide(LAP, rb.operation.id, { decision: "approve", planDigest: rb.operation.planDigest });
  assert.equal((await ops.execute(LOP, rb.operation.id)).ok, true);
  assert.deepEqual(f.phases.http_request_firewall_custom.rules, [FOREIGN]);
  assert.ok(f.calls.some((c) => c.startsWith("DELETE /rulesets/")));
});

test("Cloudflare live: a zone that does not match inventory, or a rejected token, stops before anything is planned or written; preflight is read-only", async () => {
  for (const over of [{ zoneName: "someone-elses-zone.dev" }, { account: "9".repeat(32) }]) {
    const f = fakeCloudflare(over);
    const r = await liveOps(f).request(LOP, { targetId: "lab-cf", changeType: "waf-custom-rule.add", params: WAF });
    assert.equal(r.code, "scope_mismatch");
    assert.equal(writes(f), 0);
  }
  const http = createGuardedHttp({ allowedHosts: ["api.cloudflare.com"], fetchImpl: fakeCloudflare().fetch });
  const bad = createCloudflareEdgeAdapter({ http, target: LIVE_T, env: { CF_TOKEN_LAB: "wrong" } });
  await assert.rejects(bad.verifyScope(), /token_rejected/);

  const f = fakeCloudflare({ phases: { http_request_firewall_custom: { id: "a".repeat(32), version: 7, rules: [FOREIGN] } } });
  const adapter = createCloudflareEdgeAdapter({ http: createGuardedHttp({ allowedHosts: ["api.cloudflare.com"], fetchImpl: f.fetch }), target: LIVE_T, env: { CF_TOKEN_LAB: TOKEN } });
  const pre = await adapter.preflight();
  assert.ok(pre.checks.every((c) => c.pass), JSON.stringify(pre.checks));
  assert.equal(pre.checks.length, 4);
  assert.ok(pre.notExercised.includes("rule add reply"));
  assert.equal(writes(f), 0);
});

test("Cloudflare targets: live settings need the real API host, a zone and account id, and a zone name that is not a placeholder", () => {
  assert.deepEqual(loadTargets([LIVE_T], { live: true }).problems, []);
  const bad = loadTargets([{ ...LIVE_T, host: "api.example.com", zoneId: "short", accountId: undefined, zoneName: "x" }], { live: true }).problems.join(" | ");
  assert.match(bad, /api\.cloudflare\.com/); assert.match(bad, /zoneId/); assert.match(bad, /accountId/);
  const live = (zoneName) => () => createTargetResolver({ mode: "live", targets: new Map([["z", { ...LIVE_T, mode: "live", scope: { accountId: ACCOUNT, zoneId: ZONE, zoneName } }]]), fixtures: SIMULATOR_TARGETS });
  for (const placeholder of ["edge-a.shop.example", "shop.test", "example.com", "localhost"]) assert.throws(live(placeholder), (e) => e instanceof TargetError && e.code === "PLACEHOLDER_ZONE_IN_LIVE_INVENTORY", placeholder);
  assert.doesNotThrow(live("lab-zone.shopco.dev"));
  assert.throws(() => createTargetResolver({ mode: "live", targets: new Map([["cf-edge-a", { ...LIVE_T, mode: "live" }]]), fixtures: SIMULATOR_TARGETS }), /RESERVED_FIXTURE_ALIAS/);
});
