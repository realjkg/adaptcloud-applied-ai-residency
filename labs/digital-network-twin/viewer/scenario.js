// Maintenance scenario panel: change a health monitor, preview the predicted effect, deploy to the simulator, and restore a
// known-good revision. Everything that decides anything happens on the server: the server owns the fixtures, builds the plan,
// re-checks it at deploy time, and verifies the result. This page only sends a monitor path and an expected response, and
// shows what comes back. It appears only for a signed-in simulator or learner session.

const panel = document.querySelector("#maintenance");
const body = panel.querySelector("[data-maintenance-body]");
const status = panel.querySelector('[role="status"]');
let csrf = null;
let canRun = false;
let plan = null;
// What the person has typed. A redraw must not throw it away, so it lives outside the elements.
let draft = null;
let sessionRevision = 0;

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
};
const say = (text) => { status.textContent = text; };

async function api(method, path, payload) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { ...(payload ? { "content-type": "application/json" } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
  let json = null; try { json = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, ok: response.ok, json };
}

const poolText = (p) => `${p.state} (${p.healthy} of ${p.total} members healthy)`;
const memberLine = (m) => `${m.id} ${m.address}:${m.port}: ${m.probe.healthy ? "healthy" : "unhealthy"}, ${m.probe.reason.replaceAll("_", " ")}${m.probe.status === null ? "" : `, status ${m.probe.status}`}`;

function draw(state) {
  const parts = [];
  parts.push(h("p", { "data-field": "desired" }, `Deployed revision ${state.desired.revision}: GET ${state.desired.monitor.path}, expecting "${state.desired.monitor.receive}".`));
  const observed = h("div", { "data-field": "observed" }, h("p", {}, `Observed pool: ${poolText(state.observed)}.`));
  for (const m of state.observed.members) observed.append(h("p", { class: "note" }, memberLine(m)));
  parts.push(observed);
  parts.push(h("p", { class: "note" }, `Known-good revision: ${state.knownGoodRevision ?? "none"}. Backend builds: ${state.fixtures.memberBuilds.map((b) => `${b.id} ${b.build}`).join(", ")}.`));

  if (canRun) {
    const path = h("input", { type: "text", name: "path", "aria-label": "Monitor path", autocomplete: "off" });
    const receive = h("input", { type: "text", name: "receive", "aria-label": "Expected response", autocomplete: "off" });
    draft ??= { path: state.desired.monitor.path, receive: state.desired.monitor.receive };
    path.value = draft.path; receive.value = draft.receive;
    path.addEventListener("input", () => { draft.path = path.value; });
    receive.addEventListener("input", () => { draft.receive = receive.value; });
    const preview = h("button", { type: "button", "data-action": "preview" }, "Preview change");
    preview.addEventListener("click", async () => {
      const r = await api("POST", "/api/scenarios/maintenance/plan", { monitor: { path: path.value, receive: receive.value } });
      if (!r.ok) { plan = null; say(`Not planned: ${r.json?.code ?? r.status}${r.json?.detail ? `. ${r.json.detail}` : ""}.`); return redraw(); }
      plan = r.json.plan; say("Planned. Nothing has changed yet."); redraw();
    });
    parts.push(h("div", { class: "stack" }, h("label", {}, "Monitor path"), path, h("label", {}, "Expected response (status or text)"), receive, preview));
  }

  if (plan) {
    const box = h("div", { class: "change", "data-field": "plan" }, h("p", {}, `Plan ${plan.id} (${plan.kind}) from revision ${plan.baseRevision}: predicted pool ${poolText(plan.predicted)}.`));
    for (const c of plan.change) box.append(h("p", { class: "note", ...(c.changed ? { "data-changed": c.id } : {}) }, `${c.id}: ${c.before} to ${c.after}${c.changed ? ` (${c.reason.replaceAll("_", " ")}${c.status === null ? "" : `, status ${c.status}`})` : ""}`));
    if (canRun) {
      const deploy = h("button", { type: "button", "data-action": "deploy" }, "Deploy to the simulator");
      deploy.addEventListener("click", async () => {
        const r = await api("POST", "/api/scenarios/maintenance/deploy", { planId: plan.id });
        say(r.ok ? `Deployed as revision ${r.json.plan.result.revision}. Observed pool: ${poolText(r.json.plan.result.observed)}.` : `Not deployed: ${r.json?.code ?? r.status}.`);
        plan = null; draft = null; await load();
      });
      const cancel = h("button", { type: "button" }, "Discard plan");
      cancel.addEventListener("click", () => { plan = null; say(""); redraw(); });
      box.append(deploy, cancel);
    }
    parts.push(box);
  }

  const list = h("div", { class: "stack", "data-field": "revisions" }, h("h3", {}, "Revisions"));
  for (const r of state.revisions) {
    const row = h("div", { class: "change", "data-revision": String(r.rev) }, h("p", {}, `Revision ${r.rev}${r.rev === state.desired.revision ? " (deployed)" : ""}: GET ${r.monitor.path} expecting "${r.monitor.receive}". Pool ${r.poolState}. ${r.source === "restore" ? `Restore of revision ${r.restoreOf}. ` : ""}By ${r.by}.`));
    if (canRun && r.rev !== state.desired.revision) {
      const restore = h("button", { type: "button", "data-action": "restore" }, `Plan a restore of revision ${r.rev}`);
      restore.addEventListener("click", async () => {
        const res = await api("POST", "/api/scenarios/maintenance/plan", { restoreRevision: r.rev });
        if (!res.ok) { say(`Not planned: ${res.json?.code ?? res.status}.`); return; }
        plan = res.json.plan; say("Restore planned. Nothing has changed yet."); redraw();
      });
      row.append(restore);
    }
    list.append(row);
  }
  parts.push(list);
  body.replaceChildren(...parts);
}

let lastState = null;
const redraw = () => { if (lastState) draw(lastState); };
async function load() {
  const r = await api("GET", "/api/scenarios/maintenance");
  if (!r.ok) { say(r.status === 401 || r.status === 404 ? "" : `Could not load: ${r.status}.`); return; }
  // Redraw only when something changed, so a background refresh never disturbs what is on screen.
  if (JSON.stringify(r.json) !== JSON.stringify(lastState)) { lastState = r.json; draw(lastState); }
}

async function refreshSession() {
  const revision = ++sessionRevision;
  const me = await fetch("/api/me", { cache: "no-store", credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (revision !== sessionRevision) return;
  const next = me && ["simulator", "learner"].includes(me.mode) && me.permissions?.includes("scenario:read") && typeof me.csrf === "string" ? me.csrf : null;
  if (next !== csrf) { csrf = next; plan = null; draft = null; lastState = null; body.replaceChildren(); say(""); }
  canRun = Boolean(next && me.permissions.includes("scenario:run"));
  panel.hidden = !csrf;
  if (csrf) await load();
}

let timer;
new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => void refreshSession(), 50); }).observe(document.querySelector("#operate"), { childList: true, subtree: true });
void refreshSession();
