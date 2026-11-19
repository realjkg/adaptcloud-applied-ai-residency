// The signed-in side of the viewer: sign-in, collection, schedule, and change requests. It exists only when the page is
// served by the control-plane service. Opened as plain static files it does nothing, and the viewer stays read-only.
//
// This code only asks. Every permission, approval, and check is enforced by the service on the server. Buttons are
// hidden for roles that lack a permission, but hiding a button is not what protects anything.

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

let csrf = "";
async function api(method, path, body) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, ok: response.ok, json };
}

const short = (d) => (typeof d === "string" ? d.slice(0, 12) : "");

/**
 * @param {object} hooks
 * @param {() => Promise<void>} hooks.onSnapshots called when the snapshot list may have changed
 * @param {(message: string, isError?: boolean) => void} hooks.say
 * @returns {Promise<{server: boolean, signedIn: boolean}>}
 */
export async function startOperate({ onSnapshots, say }) {
  const root = $("operate-root");
  const mode = await api("GET", "/api/mode").catch(() => null);
  if (!mode || !mode.ok) return { server: false, signedIn: false };

  const me = await api("GET", "/api/me");
  if (!me.ok) {
    renderSignIn(root, mode.json, () => location.reload());
    return { server: true, signedIn: false };
  }
  csrf = me.json.csrf;
  const perms = new Set(me.json.permissions);
  const state = { user: me.json.user, killSwitch: me.json.killSwitch, controls: [], picked: new Set(), file: null };

  async function refresh() {
    const [changes, schedule, controls] = await Promise.all([api("GET", "/api/changes"), api("GET", "/api/schedule"), api("GET", "/api/controls")]);
    state.controls = controls.json?.controls ?? [];
    render(changes.json?.changes ?? [], schedule.json);
  }

  function button(label, onClick, attrs = {}) {
    const b = h("button", { type: "button", ...attrs }, label);
    b.addEventListener("click", async () => { b.disabled = true; try { await onClick(); } finally { b.disabled = false; } });
    return b;
  }

  async function act(call, okMessage) {
    const r = await call();
    if (r.ok) say(okMessage);
    else say(`Refused: ${r.json?.code ?? r.json?.error ?? r.status}${r.json?.detail ? `. ${String(r.json.detail).slice(0, 160)}` : ""}.`, true);
    await refresh();
    return r;
  }

  function render(changes, schedule) {
    const parts = [];
    parts.push(h("p", { class: "note" }, `Signed in as ${state.user.name} (${state.user.roles.join(", ")}). Mode: ${mode.json.mode}.`));
    parts.push(button("Sign out", async () => { await api("POST", "/auth/logout", {}); location.reload(); }));

    if (perms.has("collect:run") || schedule) {
      const box = h("div", { class: "stack" });
      box.append(h("h3", {}, "Collection"));
      if (schedule) box.append(h("p", { class: "note" }, `Schedule every ${Math.round(schedule.intervalMs / 60000)} min. ${schedule.paused ? `Paused (${schedule.pausedBecause}).` : schedule.scheduled ? "Running." : "Not started."} Last: ${schedule.runs.at(-1) ? `${schedule.runs.at(-1).ok ? "ok" : `failed (${schedule.runs.at(-1).reason})`} at ${schedule.runs.at(-1).startedAt}` : "none"}.`));
      if (perms.has("collect:run")) box.append(button("Collect now", () => act(async () => { const r = await api("POST", "/api/collect", {}); if (r.ok && r.json?.ok !== false) await onSnapshots(); return { ...r, ok: r.ok && r.json?.ok !== false, json: r.json?.ok === false ? { error: r.json.reason } : r.json }; }, "Collected a new snapshot.")));
      if (perms.has("schedule:manage")) box.append(button(schedule?.paused ? "Resume schedule" : "Pause schedule", () => act(() => api("POST", "/api/schedule", { action: schedule?.paused ? "resume" : "pause" }), "Schedule updated.")));
      if (perms.has("killswitch:set")) box.append(button(state.killSwitch ? "Release kill switch" : "Engage kill switch", async () => { const r = await api("POST", "/api/killswitch", { on: !state.killSwitch }); if (r.ok) state.killSwitch = r.json.killSwitch; say(state.killSwitch ? "Kill switch engaged: no collection or change will run." : "Kill switch released."); await refresh(); }));
      if (state.killSwitch) box.append(h("p", { class: "note", "data-state": "error" }, "Kill switch is engaged."));
      parts.push(box);
    }

    if (perms.has("change:request")) {
      const form = h("div", { class: "stack" });
      form.append(h("h3", {}, "Request a change"));
      form.append(h("p", { class: "note" }, "Pick what to change. Each entry is one object type at one vendor. The service checks health, reads current state, and records a digest for an approver."));
      const group = h("fieldset", { id: "control-list" }, h("legend", {}, "Controls"));
      for (const c of state.controls) {
        const box = h("input", { type: "checkbox", value: c.selector });
        box.checked = state.picked.has(c.selector);
        box.addEventListener("change", () => { if (box.checked) state.picked.add(c.selector); else state.picked.delete(c.selector); });
        group.append(h("label", { class: "check" }, box, ` ${c.vendor} ${c.object}${c.writable ? "" : " (not writable on this transport)"}`));
      }
      form.append(group);
      const action = h("select", { id: "change-action", "aria-label": "Action" }, h("option", { value: "apply" }, "Apply"), h("option", { value: "destroy" }, "Remove"));
      const file = h("input", { type: "file", accept: ".json,application/json", id: "change-config", "aria-label": "Proposed config file" });
      form.append(action, h("label", { for: "change-config" }, "Proposed config (optional, otherwise the baseline)"), file);
      form.append(button("Submit request", async () => {
        let config;
        if (file.files?.[0]) { try { config = JSON.parse(await file.files[0].text()); } catch { return say("The proposed config is not valid JSON.", true); } }
        await act(() => api("POST", "/api/changes", { action: action.value, selectors: [...state.picked], ...(config ? { config } : {}) }), "Request submitted and planned. It now needs an approver.");
      }));
      parts.push(form);
    }

    const list = h("div", { class: "stack", id: "change-list" }, h("h3", {}, "Changes"));
    if (changes.length === 0) list.append(h("p", { class: "note" }, "No changes yet."));
    for (const c of changes) {
      const item = h("div", { class: "change", "data-change": c.id });
      item.append(h("p", {}, `${c.id}: ${c.action} ${c.selectors.join(", ")}`));
      item.append(h("p", { class: "note" }, `${c.status}. Requested by ${c.requester}${c.approver ? `, approved by ${c.approver}` : ""}. Digest ${short(c.digest)}. Plan: ${Object.entries(c.summary ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. ${c.transport} transport.${c.result ? ` Result: ${c.result.ok ? "ok" : `refused (${c.result.refusal})`}.` : ""}`));
      if (c.status === "pending_approval" && perms.has("change:approve")) {
        item.append(button("Approve", () => act(() => api("POST", `/api/changes/${c.id}/decision`, { decision: "approve" }), "Approved for this digest.")));
        item.append(button("Reject", () => act(() => api("POST", `/api/changes/${c.id}/decision`, { decision: "reject" }), "Rejected.")));
      }
      if (c.status === "approved" && perms.has("change:apply")) item.append(button("Execute", async () => { const r = await act(() => api("POST", `/api/changes/${c.id}/execute`, {}), "Executed."); if (r.ok) await onSnapshots(); }));
      list.append(item);
    }
    parts.push(list);
    if (perms.has("audit:read")) parts.push(button("Show audit log", async () => {
      const r = await api("GET", "/api/audit");
      const box = $("audit-box") ?? h("div", { id: "audit-box", class: "stack" });
      box.replaceChildren(h("p", { class: "note" }, `Chain ${r.json.verify.ok ? "intact" : `BROKEN at entry ${r.json.verify.brokenAt}`}, ${r.json.entries.length} recent entries.`), ...r.json.entries.slice(-12).map((e) => h("p", { class: "note" }, `${e.at} ${e.event} ${e.actor ?? ""} ${e.change ?? ""}`)));
      root.append(box);
    }));
    root.replaceChildren(...parts);
  }

  await refresh();
  return { server: true, signedIn: true };
}

function renderSignIn(root, mode, reload) {
  const parts = [h("p", { class: "note" }, "Sign in to collect, request changes, or approve them.")];
  if (mode.signIn === "sso") {
    parts.push(h("a", { href: "/auth/login", class: "button" }, "Sign in with your organization account"));
  } else {
    parts.push(h("p", { class: "note" }, "Simulator mode: pick a test persona. This sign-in is refused in live mode."));
    for (const p of mode.personas) {
      const b = h("button", { type: "button", "data-persona": p.id }, `${p.name} (${p.roles.join(", ")})`);
      b.addEventListener("click", async () => {
        const response = await fetch("/auth/persona", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: p.id }) });
        if (response.ok) reload();
      });
      parts.push(b);
    }
  }
  root.replaceChildren(...parts);
}
