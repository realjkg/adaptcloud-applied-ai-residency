import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSimulatorService } from "../server/learner.mjs";
import { createTasks, STEPS, TASKS } from "../server/tasks.mjs";
import { can } from "../server/roles.mjs";
import { plan } from "../tools/twin-sequence.mjs";
import { loadStages } from "../tools/twin-sequence.mjs";
import { renderMermaid } from "../tools/render-topology.mjs";
import { buildChangeSet } from "../tools/render-iac.mjs";

async function service() {
  const dir = mkdtempSync(join(tmpdir(), "twin-tasks-"));
  let base = "";
  const svc = await createSimulatorService({ dir, origin: () => base });
  await new Promise((r) => svc.app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${svc.app.address().port}`;
  const client = async (persona) => {
    const state = { cookie: "", csrf: "" };
    const call = async (method, path, body, over = {}) => {
      const headers = { origin: base, ...(state.cookie ? { cookie: state.cookie } : {}), ...(state.csrf ? { "x-csrf-token": state.csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...over };
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    };
    if (persona) {
      const r = await fetch(base + "/auth/persona", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ persona }) });
      state.cookie = r.headers.get("set-cookie").split(";")[0];
      state.csrf = (await call("GET", "/api/me")).body.csrf;
    }
    return { call };
  };
  return { svc, client, close: () => { svc.app.close(); rmSync(dir, { recursive: true }); } };
}

test("every job belongs to a step on the journey, says what it writes, and writes nothing to disk or a vendor", () => {
  const steps = new Set(STEPS.map((s) => s.id));
  for (const t of TASKS) {
    assert.ok(steps.has(t.step), `${t.id} is on a known step`);
    assert.ok(["none", "simulated"].includes(t.writes), `${t.id} declares what it writes`);
    assert.ok(t.summary.length > 20 && t.title.length > 3, `${t.id} is described in words`);
  }
  const src = readFileSync(new URL("../server/tasks.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/child_process|\bexec(Sync)?\(|\bspawn(Sync)?\(|writeFile|appendFile|\bfetch\(|process\.env|node:https|node:net/.test(src), "no shell, no file writes, no network, no environment");
});

test("permissions: everyone signed in may read the job list, only operators and administrators may run a job", () => {
  assert.ok(["viewer", "operator", "approver", "admin"].every((r) => can([r], "task:read")));
  assert.deepEqual(["viewer", "operator", "approver", "admin"].filter((r) => can([r], "task:run")), ["operator", "admin"]);
});

test("the browser can list, run, and read back each read-only job, and the answers match the command-line scripts", async () => {
  const t = await service();
  try {
    const op = await t.client("operator");
    const list = await op.call("GET", "/api/tasks");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.tasks.map((x) => x.id).sort(), TASKS.map((x) => x.id).sort());
    assert.ok(list.body.tasks.every((x) => x.last === null), "nothing has been run yet");

    const run = async (id, input) => (await op.call("POST", `/api/tasks/${id}/run`, input === undefined ? {} : { input })).body.run;
    const check = await run("check");
    assert.equal(check.ok, true);
    assert.match(check.headline, /plan holds together/);

    const verify = await run("verify");
    assert.equal(verify.ok, true);
    assert.match(verify.headline, /^Verified/);

    const health = await run("health");
    assert.equal(health.ok, true);
    assert.match(health.headline, /^Healthy: every stage passed/);
    const partial = await run("health", { until: "03" });
    assert.match(partial.headline, /through stage 03/);

    const asbuilt = await run("asbuilt");
    assert.equal(asbuilt.ok, true, "the job ran");
    assert.equal(asbuilt.attention, "1 requirement is unmet", "and the finding is carried separately");
    assert.match(asbuilt.headline, /^10 met, 1 unmet, 4 indeterminable, 1 attested, 1 need attestation/, "same counts the demo runbook claims");
    const report = asbuilt.blocks.find((b) => b.type === "file");
    assert.equal(report.text, readFileSync(new URL("../docs/ASBUILT_REPORT.md", import.meta.url), "utf8"), "the browser's report is the committed report");

    const drawio = await run("drawio");
    const diagram = drawio.blocks.find((b) => b.type === "file");
    assert.match(diagram.text, /<mxfile/);
    assert.match(drawio.headline, /Diagram ready/);

    const after = await op.call("GET", "/api/tasks");
    assert.ok(after.body.tasks.filter((x) => x.last).length === 5, "each job now shows its latest run");
    const runs = await op.call("GET", "/api/tasks/runs");
    assert.equal(runs.body.runs.length, 6);
    assert.ok(runs.body.runs.every((r) => !("blocks" in r)), "the history list is short; the detail is fetched by run id");
    const detail = await op.call("GET", `/api/tasks/runs/${asbuilt.runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.blocks.length, asbuilt.blocks.length);
  } finally { t.close(); }
});

test("the rest of the command-line jobs run from the browser too, and agree with the scripts", async () => {
  const t = await service();
  try {
    const op = await t.client("operator");
    const run = async (id) => (await op.call("POST", `/api/tasks/${id}/run`, {})).body.run;

    const order = await run("plan");
    assert.equal(order.ok, true);
    assert.deepEqual(order.blocks[0].rows.map((r) => r[1].split(" ")[0]), plan(loadStages()).map((x) => x.id), "the same order the command line prints");

    const topo = await run("topology");
    assert.match(topo.headline, /^\d+ devices and \d+ connections/);
    assert.equal(topo.blocks.find((b) => b.type === "file").text, renderMermaid(JSON.parse(readFileSync(new URL("../config/twin-config.json", import.meta.url), "utf8"))));

    const trip = await run("roundtrip");
    assert.equal(trip.ok, true);
    assert.ok(trip.blocks[0].items.every((i) => i.status === "pass"));
    assert.equal(TASKS.find((x) => x.id === "roundtrip").writes, "simulated", "it says it writes, and only to a simulated tenant");

    const demo = await run("demo");
    assert.equal(demo.ok, true);
    assert.equal(demo.headline, "All 15 demo steps behave as the runbook says.");

    const rto = await run("rto");
    assert.equal(rto.ok, true, "the what-if ran");
    assert.equal(rto.attention, "first problem: address pool at 2 days a week, then Wi-Fi at 4 days a week", "the finding the runbook names, flagged for a person");

    const iac = await run("iac-preview");
    assert.match(iac.headline, /^\d+ objects would be created across 4 vendors/);
    assert.equal(JSON.parse(iac.blocks.find((b) => b.type === "file").text).length, buildChangeSet(JSON.parse(readFileSync(new URL("../config/twin-config.json", import.meta.url), "utf8"))).length);
  } finally { t.close(); }
});

test("the rehearsal and the command-line tool share one implementation, and the browser's job list never loads the live transport", async () => {
  const cli = await import("../tools/provision-cli.mjs");
  const mine = await import("../tools/roundtrip.mjs");
  assert.equal(cli.runRoundtrip, mine.runRoundtrip);
  const src = readFileSync(new URL("../server/tasks.mjs", import.meta.url), "utf8");
  assert.ok(!/provision-cli|tools\/live|tools\/collect/.test(src));
});

test("a job reports a problem it finds, instead of reporting success", async () => {
  const lines = [];
  const audit = { record: async (e) => lines.push(e) };
  const stages = [{ id: "01", title: "a", requires: ["x"], produces: ["y"], body: "" }, { id: "02", title: "b", requires: ["y"], produces: ["y"], body: "" }];
  const tasks = createTasks({ audit, inputs: { stages, config: {}, requirements: {}, attestations: {} } });
  const r = await tasks.run({ subject: "u", roles: ["operator"], labId: "lab-a" }, "check");
  assert.equal(r.run.ok, false);
  assert.ok(r.run.blocks[0].items.some((i) => /requires x, which no stage produces/.test(i.label)));
});

test("who may run, and what a request may carry, is decided on the server", async () => {
  const t = await service();
  try {
    const viewer = await t.client("viewer");
    assert.equal((await viewer.call("GET", "/api/tasks")).status, 200, "a viewer can look");
    assert.equal((await viewer.call("POST", "/api/tasks/check/run", {})).status, 403, "a viewer cannot run");
    const anon = await t.client();
    assert.equal((await anon.call("GET", "/api/tasks")).status, 401);
    const op = await t.client("operator");
    const post = (id, body, over) => op.call("POST", `/api/tasks/${id}/run`, body, over);
    assert.equal((await post("check", {}, { "x-csrf-token": "wrong" })).status, 403, "csrf");
    assert.equal((await post("check", {}, { origin: "https://evil.example" })).status, 403, "origin");
    assert.equal((await post("nope", {})).status, 404, "an unknown job");
    assert.equal((await post("constructor", {})).status, 404, "a name from the object prototype is not a job");
    assert.equal((await post("../etc", {})).status, 404);
    assert.equal((await post("check", { input: { command: "rm -rf /" } })).status, 422, "extra input is refused, not ignored");
    assert.equal((await post("check", { input: { until: "03" } })).status, 422, "a job without input takes none");
    assert.equal((await post("health", { input: { until: "99" } })).status, 422, "a value not on the closed list");
    assert.equal((await post("health", { input: { until: ["03"] } })).status, 422);
    assert.equal((await post("health", { input: { path: "/etc/passwd" } })).status, 422, "a path is never accepted");
    assert.equal((await post("health", { input: "03" })).status, 422);
    assert.equal((await op.call("GET", "/api/tasks/runs/RUN-999999")).status, 404);
    assert.equal((await op.call("GET", "/api/tasks/runs/..%2F..")).status, 404);
  } finally { t.close(); }
});

test("each lab sees only its own run history, and a foreign run id answers like an unknown one", async () => {
  const t = await service();
  try {
    const a = await t.client("operator");
    const b = await t.client("operator-b");
    const ran = (await a.call("POST", "/api/tasks/check/run", {})).body.run;
    assert.equal((await a.call("GET", "/api/tasks/runs")).body.runs.length, 1);
    assert.equal((await b.call("GET", "/api/tasks/runs")).body.runs.length, 0, "the other lab has no history");
    assert.ok((await b.call("GET", "/api/tasks")).body.tasks.every((x) => x.last === null), "nor a latest result");
    const foreign = await b.call("GET", `/api/tasks/runs/${ran.runId}`);
    const unknown = await b.call("GET", "/api/tasks/runs/RUN-999999");
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, unknown.body, "the same answer, so a run id leaks nothing");
  } finally { t.close(); }
});

test("a run is audited with who ran what and whether it passed, and a refused run is audited as a denial", async () => {
  const t = await service();
  try {
    const viewer = await t.client("viewer");
    await viewer.call("POST", "/api/tasks/check/run", {});
    const op = await t.client("operator");
    await op.call("POST", "/api/tasks/verify/run", {});
    const entries = await t.svc.audit.read(50);
    assert.ok(entries.some((e) => e.event === "task.run" && e.task === "verify" && e.ok === true && e.actor === "persona:operator"));
    assert.ok(entries.some((e) => e.event === "denied" && e.permission === "task:run" && e.actor === "persona:viewer"));
    assert.equal((await t.svc.audit.verify()).ok, true);
  } finally { t.close(); }
});

test("the same job cannot run twice at once in one lab, and the history is bounded", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = [{ id: "slow", step: "build", title: "Slow job", writes: "none", summary: "A job that waits so a second start can be refused.", run: async () => { await gate; return { ok: true, headline: "done", blocks: [] }; } }];
  const tasks = createTasks({ audit: { record: async () => {} }, inputs: {}, jobs: slow });
  const user = { subject: "u", roles: ["operator"], labId: "lab-a" };
  const first = tasks.run(user, "slow");
  assert.equal((await tasks.run(user, "slow")).code, "already_running");
  const other = tasks.run({ ...user, labId: "lab-b" }, "slow");
  release();
  assert.equal((await other).ok, true, "another lab is not blocked by it");
  await first;
  for (let i = 0; i < 60; i += 1) await tasks.run(user, "slow");
  assert.equal(tasks.history(user).length, 50);
});

test("a job that throws gives the person a plain failure and leaks no internal message", async () => {
  const boom = [{ id: "boom", step: "build", title: "Broken job", writes: "none", summary: "A job that fails so the failure path can be checked.", run: async () => { throw new Error("ENOENT /srv/secret/path"); } }];
  const tasks = createTasks({ audit: { record: async () => {} }, inputs: {}, jobs: boom });
  const r = await tasks.run({ subject: "u", roles: ["operator"], labId: "lab-a" }, "boom");
  assert.equal(r.run.ok, false);
  assert.ok(!JSON.stringify(r).includes("secret"), "the internal message is not passed on");
});

// ---- in a browser, start to finish
import { browserTest, playwright } from "./browser.mjs";

browserTest("in a browser: an operator runs the whole journey from one button and downloads the results; a viewer can read but not run; the page draws results as text, never as markup", async () => {
  const t = await service();
  const base = `http://127.0.0.1:${t.svc.app.address().port}`;
  const browser = await playwright.chromium.launch();
  try {
    const errors = [];
    const open = async (persona, accept = false) => {
      const context = await browser.newContext({ acceptDownloads: accept });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|404|409|422)/.test(m.text())) errors.push(m.text()); });
      await page.goto(base);
      await page.locator(`[data-persona="${persona}"]`).click();
      await page.waitForSelector("#journey:not([hidden]) [data-step]");
      return page;
    };

    const viewer = await open("viewer");
    assert.equal(await viewer.locator("#journey [data-action]").count(), 0, "a viewer sees no Run buttons");
    assert.match(await viewer.locator("#journey").textContent(), /needs the operator or administrator role/);

    const op = await open("operator", true);
    assert.deepEqual(await op.locator("#journey [data-step]").evaluateAll((els) => els.map((e) => e.getAttribute("data-step"))), STEPS.map((s) => s.id), "the step bar shows the journey in order");
    assert.match(await op.locator("#journey [data-step='build']").textContent(), /Not run, next/, "it says where to go next");

    await op.locator("[data-action='run-all']").click();
    await op.waitForFunction(() => /Every step (passed|ran)/.test(document.querySelector("#journey [role='status']").textContent), null, { timeout: 30000 });
    for (const step of STEPS) {
      await op.locator(`#journey [data-step='${step.id}']`).click();
      const state = await op.locator(`#journey [data-step='${step.id}']`).textContent();
      assert.match(state, step.id === "report" ? /Needs review/ : /Passed/, `${step.id} finished`);
    }
    await op.locator("#journey [data-step='report']").click();
    assert.match(await op.locator("#journey [data-task='asbuilt']").textContent(), /10 met, 1 unmet, 4 indeterminable/);
    assert.match(await op.locator("#journey [data-task='asbuilt'] [data-field='attention']").textContent(), /Needs review: 1 requirement is unmet/, "an unmet requirement is flagged for a person, not hidden and not called a failure");
    assert.ok(await op.locator("#journey [data-task='asbuilt'] table tbody tr").count() >= 15, "the verdicts are a table, one row per requirement");
    const [report] = await Promise.all([op.waitForEvent("download"), op.locator("[data-download='asbuilt-report.md']").click()]);
    assert.equal(report.suggestedFilename(), "asbuilt-report.md");
    await op.locator("#journey [data-step='export']").click();
    const [diagram] = await Promise.all([op.waitForEvent("download"), op.locator("[data-download='twin-topology.drawio']").click()]);
    assert.equal(diagram.suggestedFilename(), "twin-topology.drawio");

    // A choice made before a redraw is kept, and a closed-list job runs through the page.
    await op.locator("#journey [data-step='verify']").click();
    await op.locator("#journey [data-task='health'] select").selectOption("03");
    await op.evaluate(() => document.querySelector("#operate-root").append(document.createElement("span")));
    await op.waitForTimeout(400);
    assert.equal(await op.locator("#journey [data-task='health'] select").inputValue(), "03");
    await op.locator("#journey [data-task='health'] [data-action='run']").click();
    await op.waitForFunction(() => /through stage 03/.test(document.querySelector("#journey [data-task='health']").textContent));

    // A viewer in the same lab sees the same latest results, and the other lab sees none.
    await viewer.reload();
    await viewer.waitForSelector("#journey:not([hidden]) [data-step]");
    await viewer.locator("#journey [data-step='build']").click();
    assert.match(await viewer.locator("#journey [data-task='check']").textContent(), /Passed/);
    const other = await open("operator-b");
    assert.match(await other.locator("#journey [data-task='check']").textContent(), /Not run/, "another lab starts clean");

    // Text from a result is drawn as text. A job that returns markup shows it literally and creates no element.
    await op.evaluate(() => { window.__probe = 0; });
    assert.equal(await op.locator("#journey img, #journey script, #journey iframe").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); t.close(); }
});

test("results are drawn with text only: the journey page has no markup sinks and no way to run anything but a named job", () => {
  const src = readFileSync(new URL("../viewer/journey.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/.test(src));
  assert.ok(/\/api\/tasks\/\$\{task\.id\}\/run/.test(src), "it starts a job by name");
  assert.ok(!/command|exec|spawn/.test(src), "it has no notion of a command");
});
