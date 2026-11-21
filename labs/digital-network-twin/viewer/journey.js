// Guided journey panel: the steps that used to be command-line scripts, started from the browser. The server holds the list of
// jobs and runs them; this page names a job, shows its status, and draws the result as tiles, tables, and downloads.
// Everything on screen is built with text only, never as markup, so a result cannot inject anything. It appears only for a
// signed-in simulator or learner session, and Run buttons appear only for a role that may run.

const panel = document.querySelector("#journey");
const bar = panel.querySelector("[data-journey-steps]");
const body = panel.querySelector("[data-journey-body]");
const status = panel.querySelector('[role="status"]');
let csrf = null;
let canRun = false;
let catalog = null; // { steps, tasks }
let current = null; // the step id on screen
const results = new Map(); // task id -> full run, for this page's session
const choice = new Map(); // task id -> picked value (kept outside the elements so a redraw does not lose it)
let busy = null; // task id running now
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

// Words, not colours alone: every state has a label.
const WORD = { pass: "Passed", fail: "Failed", info: "Note", skipped: "Skipped" };
const stateOf = (task) => {
  if (busy === task.id) return "running";
  const run = results.get(task.id) ?? task.last;
  return !run ? "not-run" : !run.ok ? "failed" : run.attention ? "review" : "passed";
};
const STATE_WORD = { running: "Running", passed: "Passed", review: "Needs review", failed: "Failed", "not-run": "Not run" };
const jobsOf = (step) => catalog.tasks.filter((t) => t.step === step.id);
const stepState = (step) => {
  const states = jobsOf(step).map(stateOf);
  return states.includes("failed") ? "failed" : states.includes("running") ? "running" : states.length && states.every((s) => s === "passed" || s === "review") ? (states.includes("review") ? "review" : "passed") : "not-run";
};
/** The first step that is not finished and passing: where the person should go next. */
const nextStep = () => catalog.steps.find((s) => !["passed", "review"].includes(stepState(s))) ?? null;

function download(text, mime, name) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawBlock(block) {
  if (block.type === "checks") {
    const list = h("ul", { class: "checks" });
    for (const item of block.items) list.append(h("li", { "data-status": item.status }, h("strong", {}, `${WORD[item.status] ?? item.status}: `), item.label, ...(item.detail ? [h("span", { class: "note" }, ` (${item.detail})`)] : [])));
    return list;
  }
  if (block.type === "table") {
    const t = h("table", {}, h("thead", {}, h("tr", {}, ...block.columns.map((c) => h("th", { scope: "col" }, c)))));
    const tb = h("tbody");
    for (const row of block.rows) tb.append(h("tr", {}, ...row.map((cell, i) => h("td", { "data-label": block.columns[i] ?? "" }, String(cell)))));
    t.append(tb);
    return h("div", { class: "scroll" }, t);
  }
  if (block.type === "file") {
    const button = h("button", { type: "button", "data-download": block.name }, `Download ${block.name}`);
    button.addEventListener("click", () => download(block.text, block.mime, block.name));
    return button;
  }
  return h("pre", { class: "diff" }, String(block.text ?? ""));
}

async function run(task) {
  if (busy) return;
  busy = task.id; say(`Running ${task.title}.`); draw();
  const picked = choice.get(task.id);
  const r = await api("POST", `/api/tasks/${task.id}/run`, picked ? { input: { [task.input.name]: picked } } : {});
  busy = null;
  if (r.ok) { results.set(task.id, r.json.run); say(`${task.title}: ${r.json.run.ok ? (r.json.run.attention ? "done, needs review" : "passed") : "failed"}. ${r.json.run.headline}`); }
  else say(`${task.title} did not run: ${r.json?.code ?? r.status}.`);
  await load();
  return r.ok ? r.json.run : null;
}

async function runAll() {
  for (const step of catalog.steps) for (const task of jobsOf(step)) {
    current = step.id;
    const result = await run(task);
    if (!result || !result.ok) { say(`Stopped at "${task.title}". Fix that first; later steps were not run.`); draw(); return; }
  }
  say(catalog.tasks.some((t) => stateOf(t) === "review") ? "Every step ran. Some results need review." : "Every step passed.");
}

function drawStep(step) {
  const out = [h("p", { class: "note" }, step.about)];
  for (const task of jobsOf(step)) {
    const state = stateOf(task);
    const card = h("div", { class: "change", "data-task": task.id, "data-state": state });
    card.append(h("p", {}, h("strong", {}, task.title), " ", h("span", { class: "badge", "data-state": state === "failed" ? "bad" : state }, STATE_WORD[state])), h("p", { class: "note" }, task.summary));
    if (task.input && canRun) {
      const select = h("select", { name: task.input.name, "aria-label": task.input.label });
      select.append(h("option", { value: "" }, task.input.optional ? "All stages" : "Choose"));
      for (const c of task.input.choices) select.append(h("option", { value: c }, c));
      select.value = choice.get(task.id) ?? "";
      select.addEventListener("change", () => { choice.set(task.id, select.value); });
      card.append(h("label", {}, task.input.label), select);
    }
    if (canRun) {
      const button = h("button", { type: "button", "data-action": "run", ...(busy ? { disabled: "" } : {}) }, state === "not-run" ? "Run" : "Run again");
      button.addEventListener("click", () => void run(task));
      card.append(button);
    }
    const full = results.get(task.id);
    if (full) { card.append(h("p", { "data-field": "headline" }, full.headline)); if (full.attention) card.append(h("p", { "data-field": "attention" }, `Needs review: ${full.attention}.`)); for (const block of full.blocks) card.append(drawBlock(block)); }
    else if (task.last) card.append(h("p", { class: "note" }, `Last run ${task.last.at}${task.last.by ? ` by ${task.last.by}` : ""}: ${task.last.ok ? (task.last.attention ? "needs review" : "passed") : "failed"}. Run again to see the details.`));
    out.push(card);
  }
  return out;
}

function draw() {
  if (!catalog) return;
  const next = nextStep();
  current ??= (next ?? catalog.steps[0]).id;
  const list = h("ol", { class: "steps" });
  catalog.steps.forEach((step, i) => {
    const s = stepState(step);
    const b = h("button", { type: "button", "data-step": step.id, ...(step.id === current ? { "aria-current": "step" } : {}) }, `${i + 1}. ${step.title}`, h("span", { class: "note" }, ` ${STATE_WORD[s]}${next && next.id === step.id ? ", next" : ""}`));
    b.addEventListener("click", () => { current = step.id; draw(); });
    list.append(h("li", {}, b));
  });
  bar.replaceChildren(list);
  const parts = [];
  if (canRun) {
    const all = h("button", { type: "button", "data-action": "run-all", ...(busy ? { disabled: "" } : {}) }, "Run the whole journey");
    all.addEventListener("click", () => void runAll());
    parts.push(all);
  } else parts.push(h("p", { class: "note" }, "You can read results here. Starting a job needs the operator or administrator role."));
  parts.push(...drawStep(catalog.steps.find((s) => s.id === current)));
  body.replaceChildren(...parts);
}

async function load() {
  const r = await api("GET", "/api/tasks");
  if (!r.ok) { say(r.status === 401 || r.status === 404 ? "" : `Could not load: ${r.status}.`); return; }
  catalog = r.json;
  draw();
}

async function refreshSession() {
  const revision = ++sessionRevision;
  const me = await fetch("/api/me", { cache: "no-store", credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (revision !== sessionRevision) return;
  const next = me && ["simulator", "learner"].includes(me.mode) && me.permissions?.includes("task:read") && typeof me.csrf === "string" ? me.csrf : null;
  if (next !== csrf) { csrf = next; catalog = null; current = null; results.clear(); choice.clear(); busy = null; body.replaceChildren(); bar.replaceChildren(); say(""); }
  canRun = Boolean(next && me.permissions.includes("task:run"));
  panel.hidden = !csrf;
  if (csrf && !catalog) await load();
}

let timer;
new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => void refreshSession(), 50); }).observe(document.querySelector("#operate"), { childList: true, subtree: true });
void refreshSession();
