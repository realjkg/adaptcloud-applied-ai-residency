// One end-to-end acceptance suite for the learner isolation milestone. It drives the DEPLOYED learner service (OpenID Connect
// and enrollment, no persona sign-in) with a local identity provider that signs tokens with a test key.
//
// It gives two learners separate labs, creates a change, an operation, and a snapshot in each, and proves that neither can
// list, fetch, or act on the other's records even holding valid IDs, that an unknown ID and another lab's ID are
// indistinguishable, and that no vendor call is made on a refused attempt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTest, playwright } from "./browser.mjs";
import { createLearnerDeployed, DeploymentError, main as deployedMain } from "../server/learner-deployed.mjs";
import { SIMULATOR_TARGETS } from "../server/simulator-targets.mjs";

const ORIGIN = "https://learn.test";
const IDP = "https://idp.test";
const LABS = {
  "lab-a": { members: ["sub-a-op", "sub-a-ap", "sub-a-admin"], aliases: ["pan-dfw-edge", "mx-aus-branch"] },
  "lab-b": { members: ["sub-b-op", "sub-b-ap", "sub-b-admin"], aliases: ["pan-aus-edge", "mx-plano-branch"] }
};
const GROUPS = { "sub-a-op": ["learners"], "sub-a-ap": ["reviewers"], "sub-a-admin": ["lab-admins"], "sub-b-op": ["learners"], "sub-b-ap": ["reviewers"], "sub-b-admin": ["lab-admins"], stranger: ["learners", "reviewers", "lab-admins"] };
const GROUP_ROLES = { learners: "operator", reviewers: "approver", "lab-admins": "admin" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function identityProvider() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map();
  return {
    settings: { issuer: IDP, authorizationEndpoint: `${IDP}/auth`, tokenEndpoint: `${IDP}/token`, jwksUri: `${IDP}/keys`, clientId: "learner-app" },
    /** The identity provider's authorize step: signs this person in and returns the callback URL. */
    authorize(authUrl, subject) {
      const u = new URL(authUrl);
      const code = randomBytes(8).toString("hex");
      codes.set(code, { subject, nonce: u.searchParams.get("nonce") });
      return `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`;
    },
    fetchImpl: async (url, init = {}) => {
      if (url === `${IDP}/keys`) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      if (url === `${IDP}/token`) {
        const code = new URLSearchParams(init.body.toString()).get("code");
        const rec = codes.get(code);
        if (!rec) return new Response("{}", { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const p = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: IDP, aud: "learner-app", sub: rec.subject, name: rec.subject, groups: GROUPS[rec.subject] ?? [], exp: now + 300, iat: now, nonce: rec.nonce })}`;
        return new Response(JSON.stringify({ id_token: `${p}.${createSign("RSA-SHA256").update(p).sign(privateKey).toString("base64url")}` }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }
  };
}

const settingsFor = (idp, dir, over = {}) => ({ origin: ORIGIN, dataDir: dir, oidc: idp.settings, groupRoles: GROUP_ROLES, labs: LABS, ...over });

async function deployed(over = {}) {
  const idp = identityProvider();
  const dir = mkdtempSync(join(tmpdir(), "twin-e2e-"));
  const svc = await createLearnerDeployed({ settings: settingsFor(idp, dir, over), fetchImpl: idp.fetchImpl });
  await new Promise((r) => svc.app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${svc.app.address().port}`;
  const raw = (path, init = {}) => fetch(base + path, { redirect: "manual", ...init });

  /** Signs in through the real OIDC flow and returns a client for that person. */
  async function signIn(subject) {
    const login = await raw("/auth/login");
    assert.equal(login.status, 302);
    const callbackUrl = idp.authorize(login.headers.get("location"), subject);
    const cb = await raw(new URL(callbackUrl).pathname + new URL(callbackUrl).search);
    const cookie = cb.headers.get("set-cookie")?.split(";")[0] ?? "";
    const client = { subject, status: cb.status, cookie, csrf: "" };
    client.call = async (method, path, body) => {
      const res = await raw(path, { method, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(client.csrf ? { "x-csrf-token": client.csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, body: parsed };
    };
    if (cookie) client.csrf = (await client.call("GET", "/api/me")).body.csrf;
    return client;
  }
  return { svc, idp, base, raw, signIn, dir, close: () => svc.app.close() };
}

const ADDR = (name) => ({ name, ipNetmask: "10.1.0.0/24" });
const UNKNOWN_CHANGE = "CHG-0000000000";
const UNKNOWN_OP = "OP-0000000000";
const UNKNOWN_DIGEST = "0".repeat(64);

// ---- startup and sign-in
test("the deployed learner service refuses to start without OpenID Connect, enrollment, an https origin, or with persona sign-in", async () => {
  const idp = identityProvider();
  const dir = mkdtempSync(join(tmpdir(), "twin-e2e-"));
  const refuse = async (over, code) => await assert.rejects(createLearnerDeployed({ settings: { ...settingsFor(idp, dir), ...over }, fetchImpl: idp.fetchImpl }), (e) => e instanceof DeploymentError && e.code === code, code);
  await refuse({ oidc: undefined }, "oidc_required");
  await refuse({ origin: "http://learn.test" }, "https_origin_required");
  await refuse({ labs: {} }, "labs_required");
  await refuse({ labs: undefined }, "labs_required");
  await refuse({ groupRoles: {} }, "group_roles_required");
  await refuse({ dataDir: undefined }, "data_dir_required");
  await refuse({ personas: { x: { roles: ["admin"] } } }, "personas_not_allowed");
  await refuse({ oidc: { ...idp.settings, clientSecretEnv: "X_SECRET" } }, "learner_oidc_is_a_public_client");
  await refuse({ oidc: { ...idp.settings, tokenEndpoint: "http://idp.test/token" } }, "oidc_invalid");
  await refuse({ labs: { "lab-a": { members: [], aliases: [] } } }, "lab_lab-a_incomplete");
  const nothing = mkdtempSync(join(tmpdir(), "twin-e2e-"));
  writeFileSync(join(nothing, "bad.json"), JSON.stringify({ origin: "http://x" }));
  assert.equal(await deployedMain([`--settings=${join(nothing, "bad.json")}`, "--port=0"]), 1, "the entry point exits non-zero and opens no listener");
  assert.equal(await deployedMain(["--port=0"]), 2);
});

test("the deployed learner service has no persona sign-in, and every persona name is rejected", async () => {
  const t = await deployed();
  try {
    const mode = await (await t.raw("/api/mode")).json();
    assert.deepEqual(mode, { mode: "learner", signIn: "sso", personas: [] });
    for (const persona of ["operator", "admin", "approver-b", "persona:operator", "viewer", "__proto__", ""]) {
      const res = await t.raw("/auth/persona", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ persona }) });
      assert.equal(res.status, 404, persona);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    assert.equal((await t.raw("/api/snapshots")).status, 401);
  } finally { t.close(); }
});

test("an authenticated but unenrolled account, and one enrolled in two labs, get no session and no lab access", async () => {
  const t = await deployed();
  try {
    const stranger = await t.signIn("stranger");
    assert.equal(stranger.status, 403);
    assert.equal(stranger.cookie, "", "no session cookie is issued");
    for (const path of ["/api/me", "/api/snapshots", "/api/changes", "/api/operations", "/api/targets", "/api/audit"]) assert.equal((await stranger.call("GET", path)).status, 401, path);
    assert.ok((await t.svc.audit.read()).some((e) => e.event === "login.denied" && e.actor === "stranger" && e.reason === "not_enrolled"));

    const both = await deployed({ labs: { ...LABS, "lab-b": { ...LABS["lab-b"], members: [...LABS["lab-b"].members, "sub-a-op"] } } });
    try { assert.equal((await both.signIn("sub-a-op")).status, 403, "ambiguous enrollment is refused"); } finally { both.close(); }

    // Defense in depth: even a session that somehow carries no lab can reach no lab data.
    const orphan = t.svc.sessions.create({ subject: "orphan", name: "Orphan", roles: ["admin", "approver", "operator"] });
    const call = async (method, path, body) => { const r = await t.raw(path, { method, headers: { origin: ORIGIN, cookie: `sid=${orphan.id}`, "x-csrf-token": orphan.csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; } };
    assert.deepEqual((await call("GET", "/api/snapshots")).body, { snapshots: [] });
    assert.deepEqual((await call("GET", "/api/changes")).body, { changes: [] });
    assert.deepEqual((await call("GET", "/api/operations")).body, { operations: [] });
    assert.deepEqual((await call("GET", "/api/targets")).body, { targets: [] });
    assert.equal((await call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"] })).status, 403);
    assert.equal((await call("POST", "/api/operations", { targetId: "pan-dfw-edge", changeType: "address-object.create", params: ADDR("x") })).status, 404);
    assert.equal((await call("POST", "/api/collect", {})).status, 404);
  } finally { t.close(); }
});

// ---- the two-learner isolation run
async function twoLabs(t) {
  const who = {};
  for (const s of ["sub-a-op", "sub-a-ap", "sub-a-admin", "sub-b-op", "sub-b-ap", "sub-b-admin"]) { who[s] = await t.signIn(s); assert.equal(who[s].status, 302, s); }
  const made = {};
  for (const lab of ["a", "b"]) {
    const op = who[`sub-${lab}-op`];
    const device = lab === "a" ? "pan-dfw-edge" : "pan-aus-edge";
    const change = (await op.call("POST", "/api/changes", { action: "apply", selectors: ["f5/pool"] }));
    assert.equal(change.status, 201, JSON.stringify(change.body));
    const operation = await op.call("POST", "/api/operations", { targetId: device, changeType: "address-object.create", params: ADDR(`web-${lab}`) });
    assert.equal(operation.status, 201, JSON.stringify(operation.body));
    const collected = await op.call("POST", "/api/collect", {});
    assert.equal(collected.status, 200);
    const snaps = (await op.call("GET", "/api/snapshots")).body.snapshots;
    const own = snaps.find((s) => s.snapshotId.includes("-SIM-"));
    assert.ok(own, "each lab's collection produced its own snapshot");
    made[lab] = { change: change.body.change, operation: operation.body.operation, snapshot: own, snapshots: snaps };
  }
  return { who, made };
}

test("two learners in separate labs cannot list, fetch, export, or act on each other's records, even with valid ids", async () => {
  const t = await deployed();
  try {
    const { who, made } = await twoLabs(t);
    const [aOp, aAp, aAdmin, bOp, bAp, bAdmin] = ["sub-a-op", "sub-a-ap", "sub-a-admin", "sub-b-op", "sub-b-ap", "sub-b-admin"].map((s) => who[s]);

    // Lists show only the caller's own records.
    for (const [client, lab, other] of [[aOp, "a", "b"], [bOp, "b", "a"]]) {
      assert.deepEqual((await client.call("GET", "/api/changes")).body.changes.map((c) => c.id), [made[lab].change.id]);
      assert.deepEqual((await client.call("GET", "/api/operations")).body.operations.map((o) => o.id), [made[lab].operation.id]);
      const snaps = (await client.call("GET", "/api/snapshots")).body.snapshots;
      assert.ok(snaps.every((s) => s.scope === `lab-${lab}` && s.snapshotId.startsWith(`lab-${lab}-`)));
      assert.ok(!snaps.some((s) => s.digest === made[other].snapshot.digest));
      assert.deepEqual((await client.call("GET", "/api/targets")).body.targets.map((x) => x.id).sort(), lab === "a" ? ["mx-aus-branch", "pan-dfw-edge"] : ["mx-plano-branch", "pan-aus-edge"]);
    }
    assert.notEqual(made.a.snapshot.digest, made.b.snapshot.digest);
    assert.deepEqual(made.a.snapshots.map((s) => s.digest).filter((d) => made.b.snapshots.some((s) => s.digest === d)), [], "no snapshot digest is shared between the labs");

    // Cross-lab attempts. For each, B acts on A's valid id and the answer must equal the answer for an id that does not exist.
    const sim = t.svc.sim;
    const aState = () => JSON.stringify([[...t.svc.transportFor("lab-a").state.entries()], sim.panFor("019801234560"), sim.mxFor("L_790001000000000001"), sim.sdwanFor("L_790001000000000001")]);
    const before = { state: aState(), writes: sim.writes, ops: JSON.stringify(t.svc.operations.list({ subject: "sub-a-op", labId: "lab-a" })), changes: JSON.stringify(t.svc.changes.list({ subject: "sub-a-op", labId: "lab-a" })) };
    const attempts = [
      ["GET change detail", bOp, "GET", (id) => `/api/changes/${id}`, "change"],
      ["approve change", bAp, "POST", (id) => `/api/changes/${id}/decision`, "change", { decision: "approve", planDigest: made.a.change.planDigest }],
      ["reject change", bAp, "POST", (id) => `/api/changes/${id}/decision`, "change", { decision: "reject" }],
      ["execute change", bOp, "POST", (id) => `/api/changes/${id}/execute`, "change", {}],
      ["approve operation", bAp, "POST", (id) => `/api/operations/${id}/decision`, "op", { decision: "approve", planDigest: made.a.operation.planDigest }],
      ["execute operation", bOp, "POST", (id) => `/api/operations/${id}/execute`, "op", {}],
      ["rollback operation", bOp, "POST", (id) => `/api/operations/${id}/rollback`, "op", {}],
      ["reconcile operation", bOp, "POST", (id) => `/api/operations/${id}/reconcile`, "op", {}],
      ["fetch snapshot", bOp, "GET", (id) => `/api/snapshots/${id}`, "snapshot"],
      ["place a hold on a snapshot", bAdmin, "POST", (id) => `/api/snapshots/${id}/hold`, "snapshot", { hold: true }]
    ];
    const realId = { change: made.a.change.id, op: made.a.operation.id, snapshot: made.a.snapshot.digest };
    const fakeId = { change: UNKNOWN_CHANGE, op: UNKNOWN_OP, snapshot: UNKNOWN_DIGEST };
    for (const [name, client, method, path, kind, body] of attempts) {
      const foreign = await client.call(method, path(realId[kind]), body);
      const unknown = await client.call(method, path(fakeId[kind]), body);
      assert.deepEqual(foreign, unknown, `${name}: another lab's id must answer exactly like an unknown id`);
      assert.ok(foreign.status === 404, `${name}: ${foreign.status}`);
      assert.ok(!JSON.stringify(foreign.body).includes(made.a.change.requester), `${name} leaks nothing about the owner`);
    }
    // The owner's records are untouched and no vendor call was made.
    assert.equal(aState(), before.state);
    assert.equal(sim.writes, before.writes);
    assert.equal(JSON.stringify(t.svc.operations.list({ subject: "sub-a-op", labId: "lab-a" })), before.ops);
    assert.equal(JSON.stringify(t.svc.changes.list({ subject: "sub-a-op", labId: "lab-a" })), before.changes);

    // Targets in another lab cannot be named either, and answer like a device that does not exist.
    const foreignDevice = await bOp.call("POST", "/api/operations", { targetId: "pan-dfw-edge", changeType: "address-object.create", params: ADDR("x") });
    const noDevice = await bOp.call("POST", "/api/operations", { targetId: "no-such-device", changeType: "address-object.create", params: ADDR("x") });
    assert.deepEqual(foreignDevice, noDevice);
    assert.equal((await bOp.call("POST", "/api/readiness/preflight", { targetId: "pan-dfw-edge" })).status, 403, "operators cannot preflight");
    const fp = await bAdmin.call("POST", "/api/readiness/preflight", { targetId: "pan-dfw-edge" });
    assert.deepEqual(fp, await bAdmin.call("POST", "/api/readiness/preflight", { targetId: "no-such-device" }));

    // There is no server-side export: browser exports are built from snapshots the caller could already load.
    for (const path of [`/api/snapshots/${made.a.snapshot.digest}/export`, "/api/export", `/api/snapshots/${made.a.snapshot.digest}/drawio`]) assert.equal((await bOp.call("GET", path)).status, 404, path);

    // Positive controls: the owners can do the same things.
    assert.equal((await aOp.call("GET", `/api/changes/${made.a.change.id}`)).status, 200);
    assert.equal((await aOp.call("GET", `/api/snapshots/${made.a.snapshot.digest}`)).status, 200);
    assert.equal((await aAp.call("POST", `/api/changes/${made.a.change.id}/decision`, { decision: "approve", planDigest: made.a.change.planDigest })).status, 200);
    assert.equal((await aAp.call("POST", `/api/operations/${made.a.operation.id}/decision`, { decision: "approve", planDigest: made.a.operation.planDigest })).status, 200);
    assert.equal((await aOp.call("POST", `/api/operations/${made.a.operation.id}/execute`, {})).status, 200);
    assert.equal((await aOp.call("POST", `/api/changes/${made.a.change.id}/execute`, {})).status, 200);
    assert.equal(sim.panFor("019801234560").running.size, 1);
    assert.equal(sim.panFor("019801234561").running.size, 0, "lab B's simulated firewall is untouched by lab A");
    assert.equal(t.svc.transportFor("lab-b").state.size, 0, "lab B's simulated tenant is untouched by lab A's apply");
    assert.ok((await aAdmin.call("POST", `/api/snapshots/${made.a.snapshot.digest}/hold`, { hold: true })).status === 200);
    assert.equal((await bOp.call("GET", "/api/changes")).body.changes.every((c) => c.id === made.b.change.id), true);
    void bAp;
  } finally { t.close(); }
});

test("the same bytes in two labs do not make one lab's snapshot visible to the other, and unscoped legacy records stay out of every view", async () => {
  const t = await deployed();
  try {
    const { who } = await twoLabs(t);
    const store = t.svc.store;
    const base = (await store.list({ scope: "lab-a" }))[0];
    const { snapshot } = await store.readTrusted(base.digest);
    // Lab B saves identical bytes: one object file, two index rows, no cross-visibility.
    await store.save(snapshot, { savedAt: "t", savedBy: "x", scope: "lab-b" });
    assert.ok((await who["sub-b-op"].call("GET", `/api/snapshots/${base.digest}`)).status === 200, "B now owns a row for those bytes");
    await store.save({ ...snapshot, snapshotId: "ONLY-A-1", label: "only a" }, { savedAt: "t", savedBy: "x", scope: "lab-a" });
    const onlyA = (await store.list({ scope: "lab-a" })).find((s) => s.snapshotId === "ONLY-A-1");
    assert.equal((await who["sub-b-op"].call("GET", `/api/snapshots/${onlyA.digest}`)).status, 404);

    // A legacy record: an object and an index row with no scope.
    const legacy = { ...snapshot, snapshotId: "LEGACY-1", label: "legacy" };
    const text = `${JSON.stringify(legacy, null, 2)}\n`;
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(text).digest("hex");
    writeFileSync(join(t.dir, "snapshots", "objects", `${digest}.json`), text);
    appendFileSync(join(t.dir, "snapshots", "index.jsonl"), `${JSON.stringify({ snapshotId: "LEGACY-1", digest, capturedAt: legacy.capturedAt, label: "legacy", synthetic: true, sourceKind: "synthetic-config", savedAt: "t", savedBy: "old", hold: false })}\n`);
    for (const who2 of ["sub-a-op", "sub-b-op", "sub-a-admin"]) {
      assert.ok(!(await who[who2].call("GET", "/api/snapshots")).body.snapshots.some((s) => s.snapshotId === "LEGACY-1"), `${who2} does not list it`);
      assert.equal((await who[who2].call("GET", `/api/snapshots/${digest}`)).status, 404, `${who2} cannot fetch it`);
    }
    assert.deepEqual((await store.unscoped()).map((r) => r.snapshotId), ["LEGACY-1"]);
    await store.assignScope(digest, "lab-b");
    assert.ok((await who["sub-b-op"].call("GET", "/api/snapshots")).body.snapshots.some((s) => s.snapshotId === "LEGACY-1"));
    assert.equal((await who["sub-a-op"].call("GET", `/api/snapshots/${digest}`)).status, 404, "a migration gives it to exactly one lab");
    assert.deepEqual(await store.unscoped(), []);
  } finally { t.close(); }
});

test("schedules, audit, and the kill switch do not cross labs", async () => {
  const t = await deployed();
  try {
    const { who, made } = await twoLabs(t);
    const aSched = (await who["sub-a-op"].call("GET", "/api/schedule")).body;
    const bSched = (await who["sub-b-op"].call("GET", "/api/schedule")).body;
    assert.equal(aSched.runs.length, 1);
    assert.equal(bSched.runs.length, 1);
    await who["sub-a-admin"].call("POST", "/api/schedule", { action: "pause" });
    assert.equal((await who["sub-a-admin"].call("GET", "/api/schedule")).body.paused, true);
    assert.equal((await who["sub-b-admin"].call("GET", "/api/schedule")).body.paused, false, "pausing lab A's schedule does not pause lab B's");

    const auditA = (await who["sub-a-admin"].call("GET", "/api/audit")).body;
    assert.equal(auditA.verify.ok, true);
    assert.ok(auditA.entries.length > 0);
    assert.ok(auditA.entries.every((e) => ["sub-a-op", "sub-a-ap", "sub-a-admin"].includes(e.actor)), "an administrator sees only their own lab's events");
    assert.ok(!JSON.stringify(auditA).includes(made.b.change.id) && !JSON.stringify(auditA).includes("sub-b"));
    assert.equal((await who["sub-b-op"].call("GET", "/api/audit")).status, 403);

    const kill = await who["sub-a-admin"].call("POST", "/api/killswitch", { on: true });
    assert.equal(kill.status, 403);
    assert.equal(kill.body.error, "not_available_in_learner_labs");
    assert.equal(t.svc.killSwitch.get(), false);
    assert.equal((await who["sub-b-op"].call("POST", "/api/collect", {})).status, 200, "lab B still collects");
  } finally { t.close(); }
});

test("reconcile over HTTP: another lab's operation answers like an unknown one, and a lab's own uncertain operation needs the right role", async () => {
  const t = await deployed();
  try {
    const a = { op: await t.signIn("sub-a-op"), ap: await t.signIn("sub-a-ap"), admin: await t.signIn("sub-a-admin") };
    const b = { op: await t.signIn("sub-b-op"), ap: await t.signIn("sub-b-ap") };
    // Make lab A's operation uncertain: the simulated commit never finishes.
    const req = await a.op.call("POST", "/api/operations", { targetId: "pan-dfw-edge", changeType: "address-object.create", params: ADDR("stuck") });
    await a.ap.call("POST", `/api/operations/${req.body.operation.id}/decision`, { decision: "approve", planDigest: req.body.operation.planDigest });
    t.svc.sim.nextWrite = "commit-stuck";
    const run = await a.op.call("POST", `/api/operations/${req.body.operation.id}/execute`, {});
    assert.equal(run.body.operation.status, "uncertain");
    assert.equal(run.body.operation.manualReview, null, "a stuck job is not a journal case");

    const writes = t.svc.sim.writes;
    const stateA = JSON.stringify(t.svc.sim.panFor("019801234560"));
    const foreign = await b.op.call("POST", `/api/operations/${req.body.operation.id}/reconcile`, {});
    const unknown = await b.op.call("POST", `/api/operations/${UNKNOWN_OP}/reconcile`, {});
    assert.deepEqual(foreign, unknown);
    assert.equal(foreign.status, 404);
    assert.deepEqual(await b.ap.call("POST", `/api/operations/${req.body.operation.id}/reconcile`, {}), await b.ap.call("POST", `/api/operations/${UNKNOWN_OP}/reconcile`, {}), "even a role that cannot reconcile learns nothing");
    assert.equal(t.svc.sim.writes, writes);
    assert.equal(JSON.stringify(t.svc.sim.panFor("019801234560")), stateA);

    // The owning lab: roles are enforced, and the simulated deployment has no commit journal to settle from.
    assert.equal((await a.ap.call("POST", `/api/operations/${req.body.operation.id}/reconcile`, {})).status, 403);
    const own = await a.op.call("POST", `/api/operations/${req.body.operation.id}/reconcile`, {});
    assert.equal(own.status, 422);
    assert.equal(own.body.code, "no_commit_journal");
    assert.equal(t.svc.sim.writes, writes, "reconcile never writes");
  } finally { t.close(); }
});

// ---- the browser run
browserTest("in two browsers: two learners sign in with the identity provider, each creates a change and a snapshot, and neither can see or act on the other's", async () => {
  const t = await deployed();
  const browser = await playwright.chromium.launch();
  try {
    const errors = [];
    // The browser reaches the service at its https origin; the test maps that origin onto the local listener and plays the identity provider.
    const open = async (subject) => {
      const ctx = await browser.newContext();
      await ctx.route(/^https:\/\/learn\.test\//, async (route) => {
        const u = new URL(route.request().url());
        const res = await route.fetch({ url: `${t.base}${u.pathname}${u.search}`, maxRedirects: 0 });
        const loc = res.headers().location ?? "";
        if (res.status() === 302 && loc.startsWith(`${IDP}/auth`)) {
          // The service's own sign-in redirect points at the identity provider. This plays the identity provider and the
          // browser's trip back to the callback, which the service then handles for real: state, nonce, PKCE, token exchange,
          // signature check, enrollment. A redirect hop would bypass interception, so the hops are followed here.
          const back = new URL(t.idp.authorize(loc, subject));
          const cb = await route.fetch({ url: `${t.base}${back.pathname}${back.search}`, maxRedirects: 0 });
          const sid = /(?:^|\n)sid=([^;]+)/.exec(cb.headers()["set-cookie"] ?? "")?.[1];
          if (cb.status() !== 302 || !sid) return route.fulfill({ response: cb });
          await ctx.addCookies([{ name: "sid", value: sid, url: ORIGIN, httpOnly: true, secure: true, sameSite: "Strict" }]);
          return route.fulfill({ status: 200, contentType: "text/html", body: '<meta http-equiv="refresh" content="0;url=/">' });
        }
        return route.fulfill({ response: res });
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|404|409|422)/.test(m.text())) errors.push(m.text()); });
      await page.goto(ORIGIN);
      return page;
    };
    const signedIn = async (subject) => {
      const page = await open(subject);
      assert.equal(await page.locator("[data-persona]").count(), 0, "the deployed page offers no persona sign-in");
      await page.getByRole("link", { name: "Sign in with your organization account" }).click();
      await page.waitForSelector("#operate-root h3");
      return page;
    };

    const a = await signedIn("sub-a-op");
    const b = await signedIn("sub-b-op");
    const own = {};
    for (const [page, lab] of [[a, "a"], [b, "b"]]) {
      await page.getByRole("button", { name: "Collect now" }).click();
      await page.waitForFunction(() => [...document.querySelectorAll("#snapshot-select option")].some((o) => /Simulated collection/.test(o.textContent)));
      await page.locator("#control-list input[value='f5/pool']").check();
      await page.getByRole("button", { name: "Submit request" }).click();
      await page.waitForSelector("[data-change]");
      own[lab] = await page.evaluate(async () => {
        const changes = (await (await fetch("/api/changes", { credentials: "same-origin" })).json()).changes;
        const snaps = (await (await fetch("/api/snapshots", { credentials: "same-origin" })).json()).snapshots;
        return { change: changes[0].id, planDigest: changes[0].planDigest, snapshot: snaps.find((s) => /-SIM-/.test(s.snapshotId)).digest, changeCount: changes.length };
      });
      assert.equal(own[lab].changeCount, 1);
      const options = await page.locator("#snapshot-select option").allTextContents();
      assert.ok(options.every((o) => o.includes(`(lab-${lab})`)), `lab ${lab} page lists only its own snapshots: ${options.join(" | ")}`);
      assert.equal(await page.locator("[data-change]").count(), 1);
    }
    assert.notEqual(own.a.change, own.b.change);

    // B's page tries A's valid ids, through the same session, and gets what an unknown id gets.
    const attempt = (page, who) => page.evaluate(async ({ real, fake }) => {
      const csrf = (await (await fetch("/api/me", { credentials: "same-origin" })).json()).csrf;
      const go = async (method, path, body) => { const r = await fetch(path, { method, credentials: "same-origin", headers: { "x-csrf-token": csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.text() }; };
      const out = [];
      for (const [m, p, body] of [["GET", `/api/changes/${real.change}`], ["POST", `/api/changes/${real.change}/execute`, {}], ["POST", `/api/changes/${real.change}/decision`, { decision: "approve", planDigest: real.planDigest }], ["GET", `/api/snapshots/${real.snapshot}`]]) {
        const f = (x) => x.replace(real.change, fake.change).replace(real.snapshot, fake.snapshot);
        out.push({ real: await go(m, p, body), fake: await go(m, f(p), body) });
      }
      return out;
    }, { real: who, fake: { change: UNKNOWN_CHANGE, snapshot: UNKNOWN_DIGEST } });
    for (const r of await attempt(b, own.a)) { assert.deepEqual(r.real, r.fake); assert.equal(r.real.status, 404); }
    for (const r of await attempt(a, own.b)) { assert.deepEqual(r.real, r.fake); assert.equal(r.real.status, 404); }
    assert.equal(t.svc.transportFor("lab-a").state.size + t.svc.transportFor("lab-b").state.size, 0, "no vendor change happened");

    // An authenticated but unenrolled account lands on a refusal, not on a lab.
    const stranger = await open("stranger");
    await stranger.getByRole("link", { name: "Sign in with your organization account" }).click();
    await stranger.waitForLoadState();
    assert.match(await stranger.locator("body").textContent(), /not enrolled in a lab/);
    assert.equal((await stranger.evaluate(async () => (await fetch("/api/snapshots", { credentials: "same-origin" })).status)), 401);

    // The deployed page cannot be talked into persona sign-in.
    const persona = await a.evaluate(async () => (await fetch("/auth/persona", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: "admin" }) })).status);
    assert.equal(persona, 404);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); t.close(); }
});
