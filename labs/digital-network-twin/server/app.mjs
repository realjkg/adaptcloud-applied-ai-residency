// The control-plane service. It serves the viewer and a small JSON API behind sign-in.
//
//   - Every /api route needs a session. Sessions come from OpenID Connect, or, in simulator mode only, from a fixed
//     list of personas. Live mode refuses persona sign-in.
//   - Roles are checked on the server for every action. The browser's idea of its role is only for drawing buttons.
//   - State-changing requests need the session's CSRF token, a JSON body, and an Origin that matches this service.
//   - Writes go only through the change workflow, which uses the guarded provisioning gate.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { can, permissionsFor, rolesFromGroups } from "./roles.mjs";
import { parseCookies } from "./sessions.mjs";
import { evaluateSdwan } from "./adapters/sdwan-model.mjs";

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer");
const ASSETS = { "scenario.js": "text/javascript; charset=utf-8", "sdwan.js": "text/javascript; charset=utf-8", "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "operate.js": "text/javascript; charset=utf-8", "render.js": "text/javascript; charset=utf-8", "layout.js": "text/javascript; charset=utf-8", "snapshot.js": "text/javascript; charset=utf-8", "drawio.js": "text/javascript; charset=utf-8", "viewer.css": "text/css; charset=utf-8" };
// A request names an asset; it never supplies a path. The files served are exactly these constants, found by an exact Map lookup,
// so a name like "constructor" or "__proto__" finds nothing and no request text reaches the filesystem.
const ASSET_FILES = new Map(Object.entries(ASSETS).map(([name, type]) => [name, { path: join(VIEWER, name), type }]));
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"
};
const MAX_BODY = 256 * 1024;
const HEX = /^[0-9a-f]{64}$/;
const CHG = /^CHG-[0-9A-F]{10}$/;

/**
 * Modes: "simulator" is the local test entry (persona sign-in); "learner" is the deployed learner service (OpenID Connect and
 * enrollment, simulated vendors only, no persona route at all); "live" is the private control plane.
 *
 * The lab a session belongs to is resolved on the server at sign-in (persona table, enrollment, or "live") and stored in the
 * session. Nothing in a request body or header can set it. A session with no lab can reach no lab data.
 */
export function createApp({ mode, origin, secureCookies = false, sessions, oidc = null, enrollment = null, personas = {}, groupRoles = {}, store, scheduler, schedulerFor = null, changes, operations = null, readiness = null, scenarios = null, tasks = null, audit, auditFilter = null, collectNow, killSwitch }) {
  if (!["simulator", "learner", "live"].includes(mode)) throw new Error("mode must be simulator, learner, or live");
  if ((mode === "live" || mode === "learner") && !oidc) throw new Error(`${mode} mode requires OpenID Connect sign-in`);
  if (mode === "learner" && typeof enrollment?.resolve !== "function") throw new Error("learner mode requires enrollment");
  if (mode !== "simulator" && Object.keys(personas).length > 0) throw new Error("persona sign-in exists only in simulator mode");
  const labScoped = mode !== "live";

  return createServer(async (req, res) => {
    const send = (status, body, type = "text/plain; charset=utf-8", extra = {}) => {
      res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const json = (status, value, extra) => send(status, JSON.stringify(value), "application/json; charset=utf-8", extra);
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const cookie = (id, maxAge) => `sid=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
    const sessionId = parseCookies(req.headers.cookie).sid;
    const session = sessions.get(sessionId);

    try {
      // Static files are public; they hold no data.
      if (req.method === "GET" || req.method === "HEAD") {
        if (parts.length === 0) { const a = ASSET_FILES.get("index.html"); return send(200, await readFile(a.path), a.type); }
        if (parts.length === 1 && parts[0] === "favicon.ico") return send(204, "");
        const asset = parts.length === 1 ? ASSET_FILES.get(parts[0]) : undefined;
        if (asset) return send(200, await readFile(asset.path), asset.type);
      }

      if (parts[0] === "auth") {
        if (req.method === "GET" && parts[1] === "login" && oidc) return send(302, "", "text/plain", { Location: oidc.begin() });
        if (req.method === "GET" && parts[1] === "callback" && oidc) {
          try {
            const who = await oidc.complete({ state: url.searchParams.get("state"), code: url.searchParams.get("code") });
            const roles = rolesFromGroups(who.groups, groupRoles);
            if (roles.length === 0) { await audit.record({ event: "login.denied", actor: who.subject, reason: "no_role" }); return send(403, "no role is assigned to this account"); }
            // The lab comes from enrollment on the server. An account the identity provider knows but nobody enrolled gets nothing.
            const labId = mode === "learner" ? enrollment.resolve(who.subject) : "live";
            if (labId === null) { await audit.record({ event: "login.denied", actor: who.subject, reason: "not_enrolled" }); return send(403, "this account is not enrolled in a lab"); }
            const s = sessions.create({ subject: who.subject, name: who.name, roles, labId });
            await audit.record({ event: "login", actor: who.subject, roles: roles.join(",") });
            return send(302, "", "text/plain", { Location: "/", "Set-Cookie": cookie(s.id, 28800) });
          } catch (error) {
            await audit.record({ event: "login.failed", reason: String(error.message).replace(/[^a-z_]/g, "").slice(0, 40) });
            return send(401, "sign-in failed");
          }
        }
        if (req.method === "POST" && parts[1] === "persona") {
          if (mode !== "simulator") return json(404, { error: "not_found" });
          const body = await readJson(req, origin);
          const persona = typeof body.persona === "string" && Object.hasOwn(personas, body.persona) ? personas[body.persona] : null;
          if (!persona) return json(401, { error: "unknown_persona" });
          const s = sessions.create({ subject: `persona:${body.persona}`, name: persona.name, roles: persona.roles, labId: persona.lab });
          await audit.record({ event: "login", actor: `persona:${body.persona}`, roles: persona.roles.join(","), mode: "simulator" });
          return json(200, { ok: true }, { "Set-Cookie": cookie(s.id, 28800) });
        }
        if (req.method === "POST" && parts[1] === "logout") {
          if (session) { if (!sessions.csrfOk(session, req.headers["x-csrf-token"])) return json(403, { error: "csrf" }); sessions.destroy(sessionId); }
          return json(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
        }
        return json(404, { error: "not_found" });
      }

      if (parts[0] !== "api") return send(404, "not found");
      if (req.method === "GET" && parts[1] === "mode") return json(200, { mode, signIn: oidc ? "sso" : "persona", personas: mode === "simulator" ? Object.entries(personas).map(([id, p]) => ({ id, name: p.name, roles: p.roles })) : [] });
      if (!session) return json(401, { error: "sign_in_required" });
      const user = { subject: session.user.subject, name: session.user.name, roles: session.user.roles, labId: typeof session.user.labId === "string" ? session.user.labId : null };
      const writes = !["GET", "HEAD"].includes(req.method);
      if (writes && !sessions.csrfOk(session, req.headers["x-csrf-token"])) return json(403, { error: "csrf" });
      const need = async (permission) => { if (can(user.roles, permission)) return true; await audit.record({ event: "denied", actor: user.subject, permission }); json(403, { error: "forbidden" }); return false; };
      const body = writes ? await readJson(req, origin) : null;

      if (req.method === "GET" && parts[1] === "me") return json(200, { user: { name: user.name, roles: user.roles }, permissions: permissionsFor(user.roles), csrf: session.csrf, mode, killSwitch: killSwitch.get() });

      if (req.method === "POST" && url.pathname === "/api/sdwan/evaluate") {
        if (!labScoped || !user.labId) return json(404, { error: "not_found" });
        if (!(await need("operation:read"))) return;

        const { policy, observations, previous } = body;
        const isObject = value =>
          value !== null && typeof value === "object" && !Array.isArray(value);

        if (!isObject(policy) || !isObject(observations) ||
            ["wan1", "wan2"].some(path => observations[path] != null && !isObject(observations[path]))) {
          return json(422, { error: "invalid_sdwan_input" });
        }

        let result;
        try {
          result = evaluateSdwan({ policy, observations, previous });
        } catch (error) {
          if (![
            "invalid_policy", "invalid_uplinks", "invalid_failback_policy", "invalid_previous_path",
            "invalid_threshold", "invalid_observation"
          ].includes(error?.message)) throw error;
          return json(422, { error: error.message });
        }
        return json(200, result);
      }

      if (parts[1] === "scenarios" && parts[2] === "maintenance" && scenarios) {
        const code = (r, ok = 200) => (r.ok ? ok : r.code === "forbidden" ? 403 : r.code === "not_found" ? 404 : r.code?.startsWith("already_") || r.code === "stale_plan_new_plan_required" || r.code === "plan_expired" ? 409 : 422);
        if (req.method === "GET" && parts.length === 3) { if (!(await need("scenario:read"))) return; const v = scenarios.get(user); return v ? json(200, v) : json(404, { error: "not_found" }); }
        if (req.method === "POST" && parts[3] === "plan" && parts.length === 4) { const r = await scenarios.plan(user, body); return json(code(r, 201), r); }
        if (req.method === "POST" && parts[3] === "deploy" && parts.length === 4) { const r = await scenarios.deploy(user, body.planId); return json(code(r), r); }
        if (req.method === "GET" && parts[3] === "plans" && parts.length === 5) { if (!(await need("scenario:read"))) return; const p = scenarios.getPlan(user, parts[4]); return p ? json(200, { plan: p }) : json(404, { ok: false, code: "not_found" }); }
      }
      if (parts[1] === "tasks" && tasks) {
        const TASKID = /^[a-z][a-z0-9-]{0,30}$/;
        const RUNID = /^RUN-[0-9]{6}$/;
        const code = (r) => (r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "not_found" ? 404 : r.code === "already_running" ? 409 : 422);
        if (req.method === "GET" && parts.length === 2) { if (!(await need("task:read"))) return; const list = tasks.list(user); return list ? json(200, { steps: tasks.steps(), tasks: list }) : json(404, { error: "not_found" }); }
        if (req.method === "GET" && parts[2] === "runs" && parts.length === 3) { if (!(await need("task:read"))) return; const h = tasks.history(user); return h ? json(200, { runs: h }) : json(404, { error: "not_found" }); }
        if (req.method === "GET" && parts[2] === "runs" && RUNID.test(parts[3] ?? "") && parts.length === 4) { if (!(await need("task:read"))) return; const r = tasks.get(user, parts[3]); return r ? json(200, { run: r }) : json(404, { error: "not_found" }); }
        if (req.method === "POST" && TASKID.test(parts[2] ?? "") && parts[3] === "run" && parts.length === 4) { const r = await tasks.run(user, parts[2], body.input ?? {}); return json(code(r), r); }
      }
      if (parts[1] === "snapshots") {
        if (!(await need("snapshot:read"))) return;
        // Access is checked before metadata or content leaves the store: a hash proves integrity, not permission.
        if (user.labId === null) return json(req.method === "GET" && parts.length === 2 ? 200 : 404, req.method === "GET" && parts.length === 2 ? { snapshots: [] } : { error: "not_found" });
        if (req.method === "GET" && parts.length === 2) return json(200, { snapshots: await store.list({ scope: user.labId }) });
        if (req.method === "GET" && parts.length === 3 && HEX.test(parts[2])) {
          try { return send(200, (await store.read(parts[2], { scope: user.labId })).text, "application/json; charset=utf-8"); } catch { return json(404, { error: "not_found" }); }
        }
        if (req.method === "POST" && parts[3] === "hold" && HEX.test(parts[2])) {
          if (!(await need("snapshot:hold"))) return;
          try { await store.setHold(parts[2], body.hold === true, { scope: user.labId ?? "" }); } catch { return json(404, { error: "not_found" }); }
          await audit.record({ event: "snapshot.hold", actor: user.subject, digest: parts[2], hold: body.hold === true });
          return json(200, { ok: true });
        }
      }
      if (parts[1] === "collect" && req.method === "POST") {
        if (!(await need("collect:run"))) return;
        const sched = schedulerFor ? schedulerFor(user) : scheduler;
        if (!sched) return json(404, { error: "not_found" });
        await audit.record({ event: "collect.requested", actor: user.subject });
        return json(200, await sched.runNow());
      }
      if (parts[1] === "schedule") {
        const sched = schedulerFor ? schedulerFor(user) : scheduler;
        if (!sched) return json(404, { error: "not_found" });
        if (req.method === "GET") return json(200, sched.status());
        if (req.method === "POST") {
          if (!(await need("schedule:manage"))) return;
          if (body.action === "pause") sched.pause("admin"); else if (body.action === "resume") sched.resume(); else return json(400, { error: "action_invalid" });
          await audit.record({ event: `schedule.${body.action}`, actor: user.subject });
          return json(200, sched.status());
        }
      }
      if (parts[1] === "killswitch" && req.method === "POST") {
        if (!(await need("killswitch:set"))) return;
        // The switch is deployment-wide. A lab administrator must not be able to stop every other lab; platform operators use deployment controls.
        if (mode === "learner") return json(403, { error: "not_available_in_learner_labs" });
        killSwitch.set(body.on === true);
        await audit.record({ event: "killswitch", actor: user.subject, on: body.on === true });
        return json(200, { killSwitch: killSwitch.get() });
      }
      if (parts[1] === "controls" && req.method === "GET") { if (!(await need("change:read"))) return; return json(200, { controls: changes.controls(user) }); }
      if (parts[1] === "changes") {
        if (req.method === "GET" && parts.length === 2) { if (!(await need("change:read"))) return; return json(200, { changes: changes.list(user) }); }
        if (req.method === "GET" && CHG.test(parts[2] ?? "") && parts.length === 3) { if (!(await need("change:read"))) return; const c = changes.get(user, parts[2]); return c ? json(200, { change: c }) : json(404, { ok: false, code: "not_found" }); }
        if (req.method === "POST" && parts.length === 2) {
          const r = await changes.request(user, { action: body.action, selectors: body.selectors, config: body.config });
          return json(r.ok ? 201 : r.code === "forbidden" ? 403 : 422, r);
        }
        if (req.method === "POST" && CHG.test(parts[2] ?? "") && parts[3] === "decision") { const r = await changes.decide(user, parts[2], body.decision, body.planDigest); return json(r.ok ? 200 : r.code === "not_found" ? 404 : r.code === "forbidden" || r.code === "self_approval" ? 403 : 409, r); }
        if (req.method === "POST" && CHG.test(parts[2] ?? "") && parts[3] === "execute") { const r = await changes.execute(user, parts[2]); return json(r.ok ? 200 : r.code === "not_found" ? 404 : r.code === "forbidden" ? 403 : 409, r); }
      }
      if (parts[1] === "targets" && req.method === "GET") { if (!(await need("operation:read"))) return; return json(200, { targets: operations ? operations.targets(user) : [] }); }
      if (parts[1] === "operations" && operations) {
        const OPID = /^OP-[0-9A-F]{10}$/;
        const code = (r, ok = 200) => (r.ok ? ok : r.code === "forbidden" || r.code === "self_approval" ? 403 : r.code === "not_found" || r.code === "target_not_available" ? 404 : r.code?.startsWith("already_") || r.code === "not_pending" || r.code === "not_approved" ? 409 : 422);
        if (req.method === "GET" && parts.length === 2) { if (!(await need("operation:read"))) return; return json(200, { operations: operations.list(user) }); }
        if (req.method === "POST" && parts.length === 2) { const r = await operations.request(user, body); return json(code(r, 201), r); }
        if (req.method === "POST" && OPID.test(parts[2] ?? "") && parts[3] === "decision") { const r = await operations.decide(user, parts[2], body); return json(code(r), r); }
        if (req.method === "POST" && OPID.test(parts[2] ?? "") && parts[3] === "execute") { const r = await operations.execute(user, parts[2]); return json(code(r), r); }
        if (req.method === "POST" && OPID.test(parts[2] ?? "") && parts[3] === "reconcile") { const r = await operations.reconcile(user, parts[2]); return json(code(r), r); }
        if (req.method === "POST" && OPID.test(parts[2] ?? "") && parts[3] === "rollback") { const r = await operations.rollback(user, parts[2]); return json(code(r, 201), r); }
      }
      if (parts[1] === "readiness" && readiness) {
        if (req.method === "GET" && parts.length === 2) { if (!(await need("readiness:read"))) return; return json(200, await readiness.state(user, operations ? operations.targets(user).map((t) => t.id) : [])); }
        if (req.method === "POST" && parts[2] === "storage-check") { const r = await readiness.runStorageCheck(user); return json(r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "already_running" ? 409 : 422, r); }
        if (req.method === "POST" && parts[2] === "preflight") { const r = await readiness.runPreflight(user, body.targetId); return json(r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "target_not_available" ? 404 : 422, r); }
      }
      if (parts[1] === "audit" && req.method === "GET") {
        if (!(await need("audit:read"))) return;
        // In a lab-scoped deployment an administrator sees only events by people enrolled in the same lab, and nothing about the rest of the chain.
        const verify = await audit.verify();
        if (labScoped) {
          const mine = auditFilter ? auditFilter(user) : null;
          return json(200, { verify: { ok: verify.ok }, entries: mine ? (await audit.read(500)).filter(mine).slice(-100) : [] });
        }
        return json(200, { verify, entries: await audit.read(100) });
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      if (error?.status) return json(error.status, { error: error.code });
      return json(500, { error: "internal" });
    }
  });
}

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

async function readJson(req, origin) {
  if (req.headers.origin !== (typeof origin === "function" ? origin() : origin)) throw new HttpError(403, "origin");
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "content_type");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, "invalid_json"); }
}
