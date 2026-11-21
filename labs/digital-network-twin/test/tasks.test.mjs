import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSimulatorService } from "../server/learner.mjs";
import { createTasks, STEPS, TASKS } from "../server/tasks.mjs";
import { can } from "../server/roles.mjs";

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
