import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOidc } from "../server/oidc.mjs";
import { can, rolesFromGroups } from "../server/roles.mjs";
import { createSessions } from "../server/sessions.mjs";
import { createSnapshotStore } from "../server/store.mjs";
import { createAudit } from "../server/audit.mjs";
import { createScheduler } from "../server/scheduler.mjs";
import { createSimulatorService } from "../server/main.mjs";
import { createApp } from "../server/app.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "twin-cp-"));
const snap = (id, capturedAt = "2026-11-17T09:00:00Z") => ({ ...JSON.parse(readFileSync(new URL("../snapshots/SYNTH-SNAP-003.json", import.meta.url), "utf8")), snapshotId: id, capturedAt });

// ---- roles
test("roles come from an exact group mapping, and unknown groups grant nothing", () => {
  const map = { "net-ops": "operator", "net-approvers": "approver", "bad": "root" };
  assert.deepEqual(rolesFromGroups(["net-ops", "other", "bad"], map), ["operator"]);
  assert.deepEqual(rolesFromGroups(["__proto__", "constructor", "toString"], map), []);
  assert.deepEqual(rolesFromGroups(undefined, map), []);
  assert.ok(can(["operator"], "change:request") && !can(["operator"], "change:approve") && !can(["viewer"], "change:request") && !can([], "snapshot:read"));
  assert.ok(!can(["approver"], "change:request"), "an approver alone cannot request");
});

// ---- sessions
test("sessions expire when idle and when old, and the csrf token must match", () => {
  let t = 0;
  const s = createSessions({ idleMs: 1000, absoluteMs: 5000, now: () => t });
  const { id, csrf } = s.create({ subject: "u" });
  assert.ok(s.get(id));
  assert.ok(s.csrfOk(s.get(id), csrf) && !s.csrfOk(s.get(id), "x") && !s.csrfOk(s.get(id), undefined));
  t = 900; assert.ok(s.get(id)); t = 1800; assert.ok(s.get(id)); t = 2900; assert.equal(s.get(id), null);
  const b = s.create({ subject: "u" }); t = 3000; for (let i = 0; i < 6; i++) { t += 900; s.get(b.id); }
  assert.equal(s.get(b.id), null, "absolute lifetime");
});

// ---- OIDC against a local provider that signs with a test key
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (claims, header = { alg: "RS256", kid: "k1" }, key = privateKey) => { const p = `${b64(header)}.${b64(claims)}`; return `${p}.${createSign("RSA-SHA256").update(p).sign(key).toString("base64url")}`; };
const CFG = { issuer: "https://idp.example", authorizationEndpoint: "https://idp.example/auth", tokenEndpoint: "https://idp.example/token", jwksUri: "https://idp.example/keys", clientId: "twin", redirectUri: "https://twin.example/auth/callback" };
function idp(claimsFor, { keys = [JWK] } = {}) {
  const seen = {};
  const fetchImpl = async (url, init = {}) => {
    if (url === CFG.jwksUri) return new Response(JSON.stringify({ keys }), { status: 200 });
    if (url === CFG.tokenEndpoint) { seen.body = init.body.toString(); return new Response(JSON.stringify({ id_token: sign(claimsFor(seen)) }), { status: 200 }); }
    return new Response("", { status: 404 });
  };
  return { fetchImpl, seen };
}
const goodClaims = (nonce, extra = {}) => ({ iss: CFG.issuer, aud: "twin", sub: "user-1", name: "Una User", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce, groups: ["net-ops"], ...extra });
async function signIn(extra, opts) {
  let nonce;
  const p = idp(() => goodClaims(nonce, extra), opts);
  const oidc = createOidc({ config: CFG, fetchImpl: p.fetchImpl });
  const u = new URL(oidc.begin());
  nonce = u.searchParams.get("nonce");
  return { oidc, u, p, run: () => oidc.complete({ state: u.searchParams.get("state"), code: "abc" }) };
}

test("OIDC sign-in uses PKCE, verifies the ID token, and returns the subject and groups", async () => {
  const s = await signIn();
  assert.equal(s.u.searchParams.get("code_challenge_method"), "S256");
  const who = await s.run();
  assert.deepEqual(who, { subject: "user-1", name: "Una User", groups: ["net-ops"] });
  assert.match(s.p.seen.body, /code_verifier=/);
});

test("OIDC rejects a bad signature, wrong issuer, wrong audience, expired token, wrong nonce, and alg none", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cases = [
    ["issuer", { iss: "https://evil.example" }, "issuer_mismatch"],
    ["audience", { aud: "someone-else" }, "audience_mismatch"],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }, "token_expired"],
    ["nonce", { nonce: "other" }, "nonce_mismatch"]
  ];
  for (const [, extra, code] of cases) { const s = await signIn(extra); await assert.rejects(s.run(), new RegExp(code)); }
  const wrongKey = await signIn({}, { keys: [{ ...other.publicKey.export({ format: "jwk" }), kid: "k1" }] });
  await assert.rejects(wrongKey.run(), /signature_invalid/);
  const oidc = createOidc({ config: CFG, fetchImpl: async (url) => url === CFG.jwksUri ? new Response(JSON.stringify({ keys: [JWK] })) : new Response(JSON.stringify({ id_token: `${b64({ alg: "none" })}.${b64(goodClaims("n"))}.` })) });
  const st = new URL(oidc.begin()).searchParams.get("state");
  await assert.rejects(oidc.complete({ state: st, code: "c" }), /alg_not_allowed/);
});

test("OIDC state is single-use and unknown state is refused", async () => {
  const s = await signIn();
  await s.run();
  await assert.rejects(s.run(), /state_invalid/);
  await assert.rejects(s.oidc.complete({ state: "nope", code: "c" }), /state_invalid/);
  assert.throws(() => createOidc({ config: { ...CFG, tokenEndpoint: "http://idp.example/token" } }), /https/);
});

// ---- store
test("the store is content-addressed, immutable, verified on read, and honors holds and retention", async () => {
  const dir = tmp();
  const store = createSnapshotStore({ dir });
  const a = await store.save(snap("OLD-1", "2026-01-01T00:00:00Z"), { savedAt: "t", savedBy: "x" });
  const again = await store.save(snap("OLD-1", "2026-01-01T00:00:00Z"), { savedAt: "t2", savedBy: "y" });
  assert.equal(again.digest, a.digest);
  assert.equal((await store.list()).length, 1);
  await assert.rejects(store.save({ nope: true }, {}), /invalid snapshot/);
  await store.save(snap("OLD-2", "2026-01-02T00:00:00Z"), { savedAt: "t", savedBy: "x" });
  const mid = await store.save(snap("MID-3", "2026-06-01T00:00:00Z"), { savedAt: "t", savedBy: "x" });
  await store.save(snap("NEW-4", "2026-11-18T00:00:00Z"), { savedAt: "t", savedBy: "x" });
  await store.setHold(a.digest, true);
  const removed = await store.applyRetention({ now: new Date("2026-11-19T00:00:00Z"), keepDays: 100, keepMin: 1 });
  assert.deepEqual(removed.sort(), ["MID-3", "OLD-2"]);
  assert.deepEqual((await store.list()).map((r) => r.snapshotId), ["OLD-1", "NEW-4"]);
  assert.equal((await store.read(a.digest)).snapshot.snapshotId, "OLD-1");
  await assert.rejects(store.read("../x"), /not a digest/);
  assert.equal((await store.verifyAll()).length, 0);
  writeFileSync(join(dir, "objects", `${a.digest}.json`), "tampered");
  await assert.rejects(store.read(a.digest), /does not match/);
  assert.deepEqual(await store.verifyAll(), ["OLD-1"]);
  assert.ok(mid.digest);
  rmSync(dir, { recursive: true });
});

// ---- audit
test("the audit log chains entries, detects edits and removals, and sanitizes values", async () => {
  const dir = tmp(); const file = join(dir, "a.jsonl");
  const audit = createAudit({ file });
  await audit.record({ event: "x", actor: "u1" });
  await audit.record({ event: "y", actor: "u<script>2", n: 3 });
  await audit.record({ event: "z", actor: "u3" });
  assert.deepEqual(await audit.verify(), { ok: true, entries: 3 });
  assert.ok(!readFileSync(file, "utf8").includes("<script>"));
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
  assert.equal((await audit.verify()).ok, false);
  writeFileSync(file, [lines[0], lines[1].replace('"n":3', '"n":4'), lines[2]].join("\n") + "\n");
  assert.equal((await audit.verify()).ok, false);
});

// ---- scheduler
test("the scheduler runs one job at a time, pauses after repeated failures, and can be paused", async () => {
  let release; let calls = 0; let ok = true;
  const timers = [];
  const s = createScheduler({ intervalMs: 60_000, maxFailures: 2, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, job: () => { calls += 1; return new Promise((r) => { release = () => r({ ok }); }); } });
  const first = s.runNow();
  assert.deepEqual(await s.runNow(), { ran: false, reason: "already_running" });
  release(); assert.equal((await first).ok, true);
  ok = false;
  const f1 = s.runNow(); release(); await f1;
  const f2 = s.runNow(); release(); await f2;
  assert.equal(s.status().paused, true);
  assert.equal(s.status().pausedBecause, "repeated_failures");
  assert.deepEqual(await s.runNow(), { ran: false, reason: "paused" });
  s.resume(); assert.equal(s.status().paused, false);
  s.pause("admin"); assert.equal((await s.runNow()).ran, false);
  assert.equal(calls, 3);
  assert.throws(() => createScheduler({ intervalMs: 10, job: () => {} }), /at least/);
  s.start(); assert.equal(s.status().scheduled, true); s.stop(); assert.equal(s.status().scheduled, false);
});

// ---- the service
async function service() {
  const dir = tmp();
  let base = "";
  const svc = await createSimulatorService({ dir, origin: () => base });
  await new Promise((r) => svc.app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${svc.app.address().port}`;
  const app = svc.app;
  const client = async (persona) => {
    const state = { cookie: "", csrf: "" };
    const call = async (method, path, body, over = {}) => {
      const headers = { origin: base, ...(state.cookie ? { cookie: state.cookie } : {}), ...(state.csrf ? { "x-csrf-token": state.csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...over };
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, headers: res.headers };
    };
    if (persona) {
      const r = await call("POST", "/auth/persona", { persona });
      state.cookie = r.headers.get("set-cookie").split(";")[0];
      state.csrf = (await call("GET", "/api/me")).body.csrf;
    }
    return { call, state };
  };
  return { svc, base, client, close: () => { app.close(); rmSync(dir, { recursive: true }); } };
}

test("the API requires sign-in, checks roles on the server, and ties writes to a csrf token and origin", async () => {
  const t = await service();
  try {
    const anon = await t.client();
    assert.equal((await anon.call("GET", "/api/snapshots")).status, 401);
    assert.equal((await anon.call("GET", "/api/me")).status, 401);
    assert.equal((await anon.call("POST", "/auth/persona", { persona: "root" })).status, 401);

    const viewer = await t.client("viewer");
    assert.equal((await viewer.call("GET", "/api/snapshots")).body.snapshots.length, 4);
    assert.equal((await viewer.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"] })).status, 403);
    assert.equal((await viewer.call("POST", "/api/collect", {})).status, 403);
    assert.equal((await viewer.call("GET", "/api/audit")).status, 403);
    assert.equal((await viewer.call("POST", "/api/killswitch", { on: true })).status, 403);

    const op = await t.client("operator");
    assert.equal((await op.call("POST", "/api/collect", {}, { "x-csrf-token": "wrong" })).status, 403, "csrf");
    assert.equal((await op.call("POST", "/api/collect", {}, { origin: "https://evil.example" })).status, 403, "origin");
    assert.equal((await op.call("POST", "/api/collect", {}, { "content-type": "text/plain" })).status, 415);
    assert.equal((await op.call("POST", "/api/collect", {})).status, 200);
    assert.equal((await viewer.call("GET", "/api/snapshots")).body.snapshots.length, 5);
    assert.ok(!(await viewer.call("GET", "/api/me")).body.permissions.includes("change:request"));
    assert.equal((await op.call("GET", "/api/snapshots/..%2F..%2Fetc")).status, 404);
  } finally { t.close(); }
});

test("a write goes request, approve by someone else, apply, and is audited with identities", async () => {
  const t = await service();
  try {
    const op = await t.client("operator");
    const ap = await t.client("approver");
    const controls = (await op.call("GET", "/api/controls")).body.controls;
    assert.ok(controls.length >= 15);
    for (const v of ["paloalto", "f5", "cloudflare", "meraki"]) assert.ok(controls.some((c) => c.vendor === v), v);

    const req = await op.call("POST", "/api/changes", { action: "apply", selectors: ["cloudflare/dns-record", "f5/pool"] });
    assert.equal(req.status, 201);
    const id = req.body.change.id;
    assert.equal((await op.call("POST", `/api/changes/${id}/execute`, {})).status, 409, "not approved yet");
    const pd = req.body.change.planDigest;
    assert.equal((await op.call("POST", `/api/changes/${id}/decision`, { decision: "approve", planDigest: pd })).status, 403, "operator cannot approve");
    assert.equal((await ap.call("POST", `/api/changes/${id}/decision`, { decision: "approve", planDigest: "0".repeat(64) })).status, 409, "approval must echo the plan digest");
    assert.equal((await ap.call("POST", `/api/changes/${id}/decision`, { decision: "approve", planDigest: pd })).status, 200);
    const done = await op.call("POST", `/api/changes/${id}/execute`, {});
    assert.equal(done.status, 200);
    assert.equal(done.body.change.status, "completed");
    assert.equal(done.body.change.transport, "simulator");
    const log = (await ap.call("GET", "/api/audit")).body;
    assert.equal(log.verify.ok, true);
    const events = log.entries.map((e) => e.event);
    for (const e of ["change.requested", "change.approved", "change.executed"]) assert.ok(events.includes(e), e);
    assert.ok(log.entries.some((e) => e.actor === "persona:operator") && log.entries.some((e) => e.actor === "persona:approver"));
  } finally { t.close(); }
});

test("nobody approves their own request, and an admin who is also an approver is still held to it", async () => {
  const t = await service();
  try {
    const admin = await t.client("admin");
    const req = await admin.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"] });
    assert.equal(req.status, 201);
    const r = await admin.call("POST", `/api/changes/${req.body.change.id}/decision`, { decision: "approve", planDigest: req.body.change.planDigest });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "self_approval");
  } finally { t.close(); }
});

test("the gate still refuses: bad scope, an unhealthy config, and an approval for a different scope", async () => {
  const t = await service();
  try {
    const op = await t.client("operator");
    assert.equal((await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/nothing"] })).status, 422);
    assert.equal((await op.call("POST", "/api/changes", { action: "apply", selectors: ["*"] })).status, 422);
    assert.equal((await op.call("POST", "/api/changes", { action: "wipe", selectors: ["f5/pool"] })).status, 422);
    const cfg = JSON.parse(readFileSync(new URL("../config/twin-config.json", import.meta.url), "utf8"));
    cfg.paloalto.rules.splice(3, 0, { name: "branch-to-pool", from: "vpn-branch", to: "app", source: "10.40.0.0/24", destination: "10.30.0.0/24", service: "tcp/8080", action: "allow", log: true });
    const risky = await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"], config: cfg });
    assert.equal(risky.status, 422);
    assert.equal(risky.body.code, "config_unhealthy");
    assert.equal((await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"], config: [] })).status, 422);
  } finally { t.close(); }
});

test("the kill switch refuses new requests and executions, and only an admin can set it", async () => {
  const t = await service();
  try {
    const op = await t.client("operator"); const ap = await t.client("approver"); const admin = await t.client("admin");
    const req = await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"] });
    await ap.call("POST", `/api/changes/${req.body.change.id}/decision`, { decision: "approve", planDigest: req.body.change.planDigest });
    assert.equal((await op.call("POST", "/api/killswitch", { on: true })).status, 403);
    assert.equal((await admin.call("POST", "/api/killswitch", { on: true })).status, 200);
    assert.equal((await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"] })).status, 422);
    const exec = await op.call("POST", `/api/changes/${req.body.change.id}/execute`, {});
    assert.equal(exec.body.change.result.refusal, "kill_switch_engaged");
    assert.equal((await op.call("POST", "/api/collect", {})).body.ok, false);
  } finally { t.close(); }
});

test("live mode requires single sign-on and refuses persona sign-in", async () => {
  const t = await service();
  try {
    assert.throws(() => createApp({ mode: "live", origin: "x", sessions: t.svc.sessions }), /OpenID Connect/);
    assert.throws(() => createApp({ mode: "demo", origin: "x" }), /mode/);
  } finally { t.close(); }
});

test("logout ends the session", async () => {
  const t = await service();
  try {
    const u = await t.client("viewer");
    assert.equal((await u.call("POST", "/auth/logout", {})).status, 200);
    assert.equal((await u.call("GET", "/api/me")).status, 401);
  } finally { t.close(); }
});

test("an oversized or malformed body is refused", async () => {
  const t = await service();
  try {
    const op = await t.client("operator");
    assert.equal((await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"], pad: "x".repeat(300_000) })).status, 413);
    const res = await fetch(`${t.base}/api/collect`, { method: "POST", headers: { origin: t.base, cookie: op.state.cookie, "x-csrf-token": op.state.csrf, "content-type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
  } finally { t.close(); }
});

// ---- browser: two people, one change
import { createRequire } from "node:module";
let playwright = null;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped without it */ }

test("in a browser: an operator requests, a different person approves, the operator applies, and a viewer sees no controls", { skip: playwright ? false : "playwright not installed" }, async () => {
  const t = await service();
  const browser = await playwright.chromium.launch();
  try {
    const errors = [];
    const open = async (persona) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|409|422)/.test(m.text())) errors.push(m.text()); });
      await page.goto(t.base);
      await page.locator(`[data-persona="${persona}"]`).click();
      await page.waitForSelector("#operate-root h3, #operate-root .note");
      await page.waitForSelector("svg [data-node]");
      return page;
    };
    const viewer = await open("viewer");
    assert.equal(await viewer.locator("#control-list").count(), 0);
    assert.equal(await viewer.getByRole("button", { name: "Collect now" }).count(), 0);

    const op = await open("operator");
    await op.getByRole("button", { name: "Collect now" }).click();
    await op.waitForFunction(() => document.querySelectorAll("#snapshot-select option").length === 5);
    await op.locator("#control-list input[value='f5/pool']").check();
    await op.locator("#control-list input[value='cloudflare/dns-record']").check();
    await op.getByRole("button", { name: "Submit request" }).click();
    await op.waitForSelector("[data-change]");
    assert.match(await op.locator("[data-change]").first().textContent(), /pending_approval/);
    assert.equal(await op.getByRole("button", { name: "Approve" }).count(), 0, "an operator sees no approve button");

    const ap = await open("approver");
    await ap.getByRole("button", { name: "Approve" }).click();
    await ap.waitForFunction(() => /approved/.test(document.querySelector("[data-change]").textContent));

    await op.reload();
    await op.waitForSelector("[data-change]");
    await op.getByRole("button", { name: "Execute" }).click();
    await op.waitForFunction(() => /completed/.test(document.querySelector("[data-change]").textContent));
    assert.match(await op.locator("[data-change]").first().textContent(), /simulator transport/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); t.close(); }
});

// ---- live wiring, with fakes only
import { createLiveService } from "../server/main.mjs";

const liveSettings = (dir, over = {}) => ({
  origin: "https://twin.example", dataDir: dir, baselinePath: new URL("../config/twin-config.json", import.meta.url).pathname,
  oidc: { ...CFG, clientId: "twin" }, groupRoles: { ops: "operator" }, tenantId: "prod-tenant-1",
  policy: { enabled: true, environment: "production", allowedTenants: ["prod-tenant-1"], allowedVendors: ["cloudflare"], transport: "live", maxOperations: 5, allowDestroy: false },
  collector: { enabled: true, acknowledgesUntested: true, synthetic: true, vendors: { cloudflare: { zoneId: "a".repeat(32), recordName: "app.lab.example", hosts: ["api.cloudflare.com"] } } },
  ...over
});
const cfFetch = async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/dns_records")) return new Response(JSON.stringify({ success: true, result: [{ name: "app.lab.example", type: "A", content: "198.51.100.2", proxied: true }] }), { headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ success: true, result: { value: "strict" } }), { headers: { "content-type": "application/json" } });
};

test("live service refuses to start without https, single sign-on, and a data directory", async () => {
  const dir = tmp();
  await assert.rejects(createLiveService({ settings: liveSettings(dir, { origin: "http://twin.example" }) }), /https/);
  await assert.rejects(createLiveService({ settings: liveSettings(dir, { oidc: undefined }) }), /OpenID/);
  await assert.rejects(createLiveService({ settings: liveSettings(dir, { dataDir: undefined }) }), /dataDir/);
});

test("live service: a scheduled collection saves a snapshot and audits it, and a refusal is audited without a snapshot", async () => {
  const dir = tmp();
  const svc = await createLiveService({ settings: liveSettings(dir), env: { CLOUDFLARE_API_TOKEN: "SYNTH-CF" }, fetchImpl: cfFetch });
  assert.equal((await svc.scheduler.runNow()).ok, true);
  assert.equal((await svc.store.list()).length, 1);
  assert.equal((await svc.store.list())[0].sourceKind, "live-collector");
  svc.killSwitch.set(true);
  assert.equal((await svc.scheduler.runNow()).ok, false);
  assert.equal((await svc.store.list()).length, 1);
  const off = await createLiveService({ settings: liveSettings(tmp(), { collector: { enabled: false, vendors: {} } }), fetchImpl: cfFetch });
  assert.equal((await off.scheduler.runNow()).reason, "collector_disabled");
  assert.ok((await off.audit.read()).some((e) => e.event === "collect.refused"));
});

test("live service: the gate refuses a write without the recorded authorization", async () => {
  const svc = await createLiveService({ settings: liveSettings(tmp()), env: {}, fetchImpl: cfFetch });
  const r = await svc.changes.request({ subject: "u", name: "U", roles: ["operator"] }, { action: "apply", selectors: ["cloudflare/dns-record"] });
  assert.equal(r.ok, false);
  assert.match(r.code, /live|authorization|environment|transport/);
});

const AUS_NET = "L_790001000000000001";
// ---- per-execution authorization over HTTP, and the hardened config-change path
test("target changes over HTTP: roles, self-approval, digest echo, expiry, drift, and a single write", async () => {
  const t = await service();
  try {
    const op = await t.client("operator"); const ap = await t.client("approver"); const viewer = await t.client("viewer"); const admin = await t.client("admin");
    const targets = (await viewer.call("GET", "/api/targets")).body.targets;
    assert.ok(targets.every((x) => !("host" in x) && !("credentialEnv" in x)), "no host or credential name reaches the browser");
    const body = { targetId: "mx-aus-branch", changeType: "l3-firewall-rule.add", params: { policy: "allow", protocol: "tcp", srcCidr: "10.40.0.0/24", srcPort: "any", destCidr: "10.20.0.100/32", destPort: "443", comment: "web" } };
    assert.equal((await viewer.call("POST", "/api/operations", body)).status, 403);
    assert.equal((await op.call("POST", "/api/operations", { ...body, targetId: "nowhere" })).status, 404, "an unknown alias and a forbidden one look the same");
    const req = await op.call("POST", "/api/operations", { ...body, url: "https://evil.example" });
    assert.equal(req.status, 201);
    const id = req.body.operation.id;
    const pd = req.body.operation.planDigest;
    assert.equal((await op.call("POST", `/api/operations/${id}/decision`, { decision: "approve", planDigest: pd })).status, 403);
    assert.equal((await ap.call("POST", `/api/operations/${id}/decision`, { decision: "approve", planDigest: "1".repeat(64), exclusiveWindow: true })).status, 422);
    assert.equal((await op.call("POST", `/api/operations/${id}/execute`, {})).status, 409, "not approved");
    assert.equal((await ap.call("POST", `/api/operations/${id}/decision`, { decision: "approve", planDigest: pd, exclusiveWindow: true })).status, 200);
    assert.equal((await ap.call("POST", `/api/operations/${id}/execute`, {})).status, 403, "an approver cannot execute");
    // Drift: someone edits the target after approval.
    t.svc.sim.mxFor(AUS_NET).rules.push({ comment: "other", policy: "allow", protocol: "any", srcPort: "any", srcCidr: "any", destPort: "any", destCidr: "any", syslogEnabled: false });
    const stale = await op.call("POST", `/api/operations/${id}/execute`, {});
    assert.equal(stale.status, 422);
    assert.equal(stale.body.code, "drift_detected_new_plan_required");
    // A new plan, a new approval, and one write even when executed twice.
    const again = await op.call("POST", "/api/operations", body);
    const id2 = again.body.operation.id;
    await ap.call("POST", `/api/operations/${id2}/decision`, { decision: "approve", planDigest: again.body.operation.planDigest, exclusiveWindow: true });
    const writesBefore = t.svc.sim.writes;
    const [x, y] = await Promise.all([op.call("POST", `/api/operations/${id2}/execute`, {}), op.call("POST", `/api/operations/${id2}/execute`, {})]);
    assert.equal(t.svc.sim.writes, writesBefore + 1);
    assert.ok([x.status, y.status].includes(200));
    assert.equal((await op.call("POST", `/api/operations/${id2}/execute`, {})).body.existing, true);
    assert.equal(t.svc.sim.mxFor(AUS_NET).rules.length, 2, "the other person's rule survived");
    const rb = await op.call("POST", `/api/operations/${id2}/rollback`, {});
    assert.equal(rb.status, 201);
    assert.equal((await op.call("POST", `/api/operations/${rb.body.operation.id}/execute`, {})).status, 409, "a rollback needs its own approval");
    assert.equal((await admin.call("POST", `/api/operations/${id2}/decision`, { decision: "approve", planDigest: pd })).status, 409);
    const log = (await ap.call("GET", "/api/audit")).body;
    assert.equal(log.verify.ok, true);
    for (const e of ["operation.requested", "operation.approved", "operation.drift", "operation.executed"]) assert.ok(log.entries.some((x2) => x2.event === e), e);
  } finally { t.close(); }
});

test("config changes (Cloudflare, F5): approval is bound to the baseline, an expired plan is refused, drift makes it stale, and a repeat writes once", async () => {
  const dir = tmp();
  let now = Date.parse("2026-11-19T10:00:00Z");
  const svc = await createSimulatorService({ dir, origin: "http://x", now: () => new Date(now) });
  const OPR = { subject: "u1", name: "Op", roles: ["operator"] }; const APR = { subject: "u2", name: "Ap", roles: ["approver"] };
  const r = await svc.changes.request(OPR, { action: "apply", selectors: ["f5/pool"] });
  assert.equal((await svc.changes.decide(APR, r.change.id, "approve", "0".repeat(64))).code, "plan_digest_mismatch");
  now += 31 * 60_000;
  assert.equal((await svc.changes.decide(APR, r.change.id, "approve", r.change.planDigest)).code, "plan_expired");

  const r2 = await svc.changes.request(OPR, { action: "apply", selectors: ["f5/pool"] });
  await svc.changes.decide(APR, r2.change.id, "approve", r2.change.planDigest);
  // The target changes after approval: a same-named object the twin does not own appears.
  svc.transport.seedUnmanaged({ vendor: "f5", object: "pool", name: "app-pool" }, { note: "someone else" });
  const stale = await svc.changes.execute(OPR, r2.change.id);
  assert.equal(stale.code, "drift_detected_new_plan_required");

  const r3 = await svc.changes.request(OPR, { action: "apply", selectors: ["f5/monitor"] });
  await svc.changes.decide(APR, r3.change.id, "approve", r3.change.planDigest);
  const [a, b] = await Promise.all([svc.changes.execute(OPR, r3.change.id), svc.changes.execute(OPR, r3.change.id)]);
  assert.ok(a.ok || b.ok);
  assert.equal((await svc.changes.execute(OPR, r3.change.id)).existing, true);
  assert.equal([...svc.transport.state.keys()].filter((k) => k.startsWith("f5/monitor/")).length, 1);
});

// ---- live wiring of target writes, with a fake vendor
test("live service: target writes are refused without the per-execution recorded authorization, and permitted hosts are exact", async () => {
  const { LIVE_WRITE_ADR } = await import("../server/live-authorization.mjs");
  const mx = { rules: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "idp.example") return new Response("{}", { status: 404 });
    if (u.hostname !== "n1.meraki.corp.test") throw new Error(`unexpected host ${u.hostname}`);
    if (init.method === "PUT") { mx.rules = JSON.parse(init.body).rules; }
    if (u.pathname.endsWith("/devices")) return new Response(JSON.stringify([{ serial: "Q2XX-ABCD-1234" }]), { headers: { "content-type": "application/json" } });
    if (!u.pathname.endsWith("/l3FirewallRules")) return new Response(JSON.stringify({ organizationId: "555001" }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ rules: [...mx.rules, { comment: "Default rule", policy: "allow", protocol: "any", srcPort: "Any", srcCidr: "Any", destPort: "Any", destCidr: "Any", syslogEnabled: false }] }), { headers: { "content-type": "application/json" } });
  };
  const target = { id: "lab-mx-1", label: "Lab MX", vendor: "meraki", environment: "lab", disposable: true, host: "n1.meraki.corp.test", organizationId: "555001", applianceSerial: "Q2XX-ABCD-1234", access: { principals: ["u1", "u2"] }, networkId: "N_1", credentialEnv: "MERAKI_KEY_LAB", changeTypes: ["l3-firewall-rule.add", "l3-firewall-rule.remove"] };
  const make = (policyExtra) => createLiveService({ settings: liveSettings(tmp(), { targets: [target], policy: { ...liveSettings(tmp()).policy, ...policyExtra } }), env: { MERAKI_KEY_LAB: "SYNTH-MX" }, fetchImpl });
  const OPR = { subject: "u1", name: "Op", roles: ["operator"], labId: "live" }; const APR = { subject: "u2", name: "Ap", roles: ["approver"], labId: "live" };
  const body = { targetId: "lab-mx-1", changeType: "l3-firewall-rule.add", params: { policy: "allow", protocol: "tcp", srcCidr: "10.40.0.0/24", srcPort: "any", destCidr: "10.20.0.100/32", destPort: "443", comment: "web" } };

  const unauthorized = await make({});
  const r = await unauthorized.operations.request(OPR, body);
  await unauthorized.operations.decide(APR, r.operation.id, { decision: "approve", planDigest: r.operation.planDigest, exclusiveWindow: true });
  const refused = await unauthorized.operations.execute(OPR, r.operation.id);
  assert.equal(refused.code, "live_not_authorized");
  assert.equal(mx.rules.length, 0, "enabling an adapter authorized nothing");

  const authorized = await make({ liveAuthorization: { adr: LIVE_WRITE_ADR, acknowledgesUntested: true } });
  const r2 = await authorized.operations.request(OPR, body);
  await authorized.operations.decide(APR, r2.operation.id, { decision: "approve", planDigest: r2.operation.planDigest, exclusiveWindow: true });
  const done = await authorized.operations.execute(OPR, r2.operation.id);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.operation.transport, "live");
  assert.equal(mx.rules.length, 1);
  await assert.rejects(createLiveService({ settings: liveSettings(tmp(), { targets: [{ ...target, environment: "production" }] }), env: {}, fetchImpl }), /disposable lab target/);
});

test("in a browser: a simulated SD-WAN change is planned, approved with an exclusive-window confirmation, and executed", { skip: playwright ? false : "playwright not installed" }, async () => {
  const t = await service();
  const browser = await playwright.chromium.launch();
  try {
    const open = async (persona) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(t.base);
      await page.locator(`[data-persona="${persona}"]`).click();
      await page.waitForSelector("#operate-root h3");
      return page;
    };
    const op = await open("operator");
    await op.locator("#op-target").selectOption("mx-aus-branch");
    await op.locator("#op-type").selectOption("sdwan.uplink-preference.set");
    await op.locator("[data-field='trafficClass']").fill("voice");
    await op.locator("[data-field='preferredUplink']").selectOption("wan2");
    await op.getByRole("button", { name: "Plan this change" }).click();
    await op.waitForSelector("[data-operation]");
    assert.match(await op.locator(".diff").first().textContent(), /\+ voice -> wan2/);
    assert.equal(await op.getByRole("button", { name: "Approve" }).count(), 0);

    const ap = await open("approver");
    await ap.waitForSelector("[data-operation]");
    await ap.getByRole("button", { name: "Approve" }).last().click();
    await ap.waitForFunction(() => /exclusive_window_confirmation_required/.test(document.querySelector("#status").textContent));
    await ap.locator("[data-exclusive]").check();
    await ap.getByRole("button", { name: "Approve" }).last().click();
    await ap.waitForFunction(() => /approved by Ana/.test(document.querySelector("[data-operation]").textContent));

    await op.reload();
    await op.waitForSelector("[data-operation]");
    await op.getByRole("button", { name: "Execute" }).click();
    await op.waitForFunction(() => /completed/.test(document.querySelector("[data-operation]").textContent));
    assert.equal(t.svc.sim.sdwanFor(AUS_NET).prefs.voice, "wan2");
  } finally { await browser.close(); t.close(); }
});

// ---- live readiness over HTTP and in a browser
test("readiness API: everyone signed in can read it, only admins can run checks, and nothing provisions, approves, or retries", async () => {
  const t = await service();
  try {
    const viewer = await t.client("viewer"); const op = await t.client("operator"); const admin = await t.client("admin");
    assert.equal((await t.client()).call && (await (await t.client()).call("GET", "/api/readiness")).status, 401);
    const read = await viewer.call("GET", "/api/readiness");
    assert.equal(read.status, 200);
    assert.equal(read.body.storage.status, "not_run");
    assert.deepEqual(read.body.targets.map((x) => x.alias).sort(), ["mx-aus-branch", "pan-dfw-edge"]);
    assert.match(read.body.notice, /never authorizes a write/);
    assert.equal((await viewer.call("POST", "/api/readiness/storage-check", {})).status, 403);
    assert.equal((await op.call("POST", "/api/readiness/preflight", { targetId: "pan-dfw-edge" })).status, 403);
    const run = await admin.call("POST", "/api/readiness/storage-check", {});
    assert.equal(run.status, 200);
    assert.equal(run.body.storage.status, "simulated_only");
    assert.equal((await admin.call("POST", "/api/readiness/preflight", { targetId: "pan-dfw-edge" })).body.preflight.status, "verified");
    assert.equal((await admin.call("POST", "/api/readiness/preflight", { targetId: "pan-aus-edge" })).status, 404);
    for (const path of ["/api/readiness/provision-storage", "/api/readiness/approve", "/api/targets", "/api/operations/OP-0000000000/retry", "/api/operations/OP-0000000000/retry-commit"]) {
      assert.ok([404, 405].includes((await admin.call("POST", path, {})).status), path);
    }
    const events = (await admin.call("GET", "/api/audit")).body.entries.map((e) => e.event);
    for (const e of ["readiness.storage_started", "readiness.storage_finished", "readiness.preflight"]) assert.ok(events.includes(e), e);
  } finally { t.close(); }
});

test("in a browser: the Live readiness panel shows three separate verdicts, and only an admin sees the buttons", { skip: playwright ? false : "playwright not installed" }, async () => {
  const t = await service();
  const browser = await playwright.chromium.launch();
  try {
    const open = async (persona) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(t.base);
      await page.locator(`[data-persona="${persona}"]`).click();
      await page.waitForSelector("#readiness");
      return page;
    };
    const viewer = await open("viewer");
    assert.match(await viewer.locator("#readiness").textContent(), /never authorizes a write/);
    assert.equal(await viewer.getByRole("button", { name: "Run storage check" }).count(), 0);
    const admin = await open("admin");
    await admin.getByRole("button", { name: "Run storage check" }).click();
    await admin.waitForFunction(() => /Simulated only/.test(document.querySelector('[data-readiness="storage"]').textContent));
    assert.match(await admin.locator('[data-readiness="storage"]').textContent(), /local simulation, not the deployed volume/);
    await admin.locator('[data-readiness="target-pan-dfw-edge"]').getByRole("button", { name: "Run read-only checks" }).click();
    await admin.waitForFunction(() => /preflight Verified/.test(document.querySelector('[data-readiness="target-pan-dfw-edge"]').textContent));
    const text = await admin.locator('[data-readiness="target-pan-dfw-edge"]').textContent();
    assert.match(text, /Not exercised by a preflight: commit submission reply, commit job status reply/);
    assert.match(text, /Approved round trip: not started/);
  } finally { await browser.close(); t.close(); }
});
