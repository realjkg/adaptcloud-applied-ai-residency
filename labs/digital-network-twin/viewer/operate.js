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
  const state = { user: me.json.user, killSwitch: me.json.killSwitch, controls: [], picked: new Set(), file: null, targets: [], operations: [], draft: { targetId: "", changeType: "", values: {} }, exclusive: new Set() };

  async function refresh() {
    const [changes, schedule, controls, targets, operations] = await Promise.all([api("GET", "/api/changes"), api("GET", "/api/schedule"), api("GET", "/api/controls"), api("GET", "/api/targets"), api("GET", "/api/operations")]);
    state.controls = controls.json?.controls ?? [];
    state.targets = targets.json?.targets ?? [];
    state.operations = operations.json?.operations ?? [];
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

    parts.push(...renderOperations());
    const list = h("div", { class: "stack", id: "change-list" }, h("h3", {}, "Changes"));
    if (changes.length === 0) list.append(h("p", { class: "note" }, "No changes yet."));
    for (const c of changes) {
      const item = h("div", { class: "change", "data-change": c.id });
      item.append(h("p", {}, `${c.id}: ${c.action} ${c.selectors.join(", ")}`));
      item.append(h("p", { class: "note" }, `${c.status}. Requested by ${c.requester}${c.approver ? `, approved by ${c.approver}` : ""}. Digest ${short(c.digest)}. Plan: ${Object.entries(c.summary ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. ${c.transport} transport.${c.result ? ` Result: ${c.result.ok ? "ok" : `refused (${c.result.refusal})`}.` : ""}`));
      if (c.status === "pending_approval" && perms.has("change:approve")) {
        item.append(button("Approve", () => act(() => api("POST", `/api/changes/${c.id}/decision`, { decision: "approve", planDigest: c.planDigest }), "Approved for this digest.")));
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

  function renderOperations() {
    const out = [];
    if (state.targets.length === 0) return out;
    if (perms.has("operation:request")) {
      const form = h("div", { class: "stack", id: "operation-form" }, h("h3", {}, "Target change"));
      form.append(h("p", { class: "note" }, "Choose an approved target and a change type. The server decides where the change goes; this page cannot name a host, URL, or command. Each change needs a different person's approval and is re-checked just before it runs."));
      const targetSel = h("select", { id: "op-target", "aria-label": "Target" }, h("option", { value: "" }, "Select a target"));
      for (const t of state.targets) targetSel.append(h("option", { value: t.id }, `${t.label} (${t.vendor}${t.disposable ? ", disposable" : ""})`));
      targetSel.value = state.draft.targetId;
      const typeSel = h("select", { id: "op-type", "aria-label": "Change type" });
      const fieldsBox = h("div", { class: "stack" });
      const typesFor = () => state.targets.find((t) => t.id === targetSel.value)?.changeTypes ?? [];
      const drawFields = () => {
        fieldsBox.replaceChildren();
        const def = typesFor().find((c) => c.id === typeSel.value);
        for (const f of def?.fields ?? []) {
          const input = f.options ? h("select", { "aria-label": f.label, "data-field": f.name }, ...f.options.map((o) => h("option", { value: o }, o))) : h("input", { type: "text", "aria-label": f.label, "data-field": f.name, placeholder: f.label, autocomplete: "off" });
          input.value = state.draft.values[f.name] ?? (f.options ? f.options[0] : "");
          input.addEventListener("input", () => { state.draft.values[f.name] = input.value; });
          if (f.options) state.draft.values[f.name] ??= f.options[0];
          fieldsBox.append(h("label", {}, f.label), input);
        }
      };
      const drawTypes = () => {
        typeSel.replaceChildren(...typesFor().map((c) => h("option", { value: c.id }, c.label)));
        state.draft.targetId = targetSel.value;
        state.draft.changeType = typeSel.value;
        drawFields();
      };
      targetSel.addEventListener("change", () => { state.draft.values = {}; drawTypes(); });
      typeSel.addEventListener("change", () => { state.draft.values = {}; state.draft.changeType = typeSel.value; drawFields(); });
      drawTypes();
      form.append(targetSel, typeSel, fieldsBox, button("Plan this change", () => act(() => api("POST", "/api/operations", { targetId: targetSel.value, changeType: typeSel.value, params: Object.fromEntries(Object.entries(state.draft.values).filter(([, v]) => v !== "")) }), "Planned. The diff below is what an approver will see.")));
      out.push(form);
    }
    const list = h("div", { class: "stack", id: "operation-list" }, h("h3", {}, "Target changes"));
    if (state.operations.length === 0) list.append(h("p", { class: "note" }, "No target changes yet."));
    for (const o of state.operations) {
      const item = h("div", { class: "change", "data-operation": o.id });
      item.append(h("p", {}, `${o.id}: ${o.changeType} on ${o.targetId}${o.rollbackOf ? ` (rollback of ${o.rollbackOf})` : ""}`));
      item.append(h("p", { class: "note" }, `${o.status}. Requested by ${o.requester}${o.approver ? `, approved by ${o.approver}` : ""}. Plan digest ${short(o.planDigest)}. Expires ${o.expiresAt}. ${o.transport} transport.${o.result ? ` Result: ${o.result.outcome}${o.result.reason ? ` (${o.result.reason})` : ""}${o.result.candidateLeftInPlace || o.result.candidateMayExist ? ". A candidate edit may be staged on the firewall and needs review" : ""}.` : ""}`));
      if (o.commitScope) item.append(h("p", { class: "note" }, `Commit scope: ${o.commitScope.kind} commit by ${o.commitScope.byAdmin} in ${o.commitScope.vsys}, objects ${o.commitScope.objects.join(", ")}. Pending changes before: ${o.commitScope.pendingBefore}.`));
      const diff = h("pre", { class: "diff", "aria-label": "Dry-run diff" });
      diff.textContent = [...o.diff.before.map((l) => `${l.change === "removed" ? "-" : " "} ${l.line}`), "---", ...o.diff.after.map((l) => `${l.change === "added" ? "+" : " "} ${l.line}`)].join("\n") + (o.diff.unrelatedRulesUnchanged === true ? "\nUnrelated rules unchanged." : "");
      item.append(diff);
      if (o.status === "pending_approval" && perms.has("operation:approve")) {
        let box = null;
        if (o.requiresExclusiveWindow) { box = h("input", { type: "checkbox", "data-exclusive": o.id }); item.append(h("label", { class: "check" }, box, " I confirm an exclusive change window: nobody else will edit this list during the write")); }
        item.append(button("Approve", () => act(() => api("POST", `/api/operations/${o.id}/decision`, { decision: "approve", planDigest: o.planDigest, exclusiveWindow: box ? box.checked : false }), "Approved for this plan.")));
        item.append(button("Reject", () => act(() => api("POST", `/api/operations/${o.id}/decision`, { decision: "reject" }), "Rejected.")));
      }
      if (o.status === "approved" && perms.has("operation:execute")) item.append(button("Execute", async () => { await act(() => api("POST", `/api/operations/${o.id}/execute`, {}), "Executed and verified."); }));
      if (o.status === "uncertain" && perms.has("operation:execute")) item.append(button("Check commit status", async () => {
        const r = await api("POST", `/api/operations/${o.id}/reconcile`, {});
        if (r.json?.code === "no_commit_was_submitted") say("No commit was submitted. That does not mean no change was made: a candidate edit may still be staged on the firewall. Inspect or clear it there.", true);
        else if (r.json?.code === "submission_uncertain_manual_review") say("A commit may have been submitted but its job id was never saved. Check the firewall's job list; nothing will be sent again.", true);
        else if (r.ok) say("Checked from the commit journal. Nothing was submitted again.");
        else say(`Refused: ${r.json?.code ?? r.json?.error ?? r.status}.`, true);
        await refresh();
      }));
      if (["completed", "uncertain"].includes(o.status) && perms.has("operation:request")) item.append(button("Plan a rollback", () => act(() => api("POST", `/api/operations/${o.id}/rollback`, {}), "A rollback was planned. It needs its own approval.")));
      list.append(item);
    }
    out.push(list);
    return out;
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
