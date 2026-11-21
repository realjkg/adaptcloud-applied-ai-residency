// Named jobs the browser can start. This is the browser's way to run what used to be command-line scripts.
//
//   - The browser sends a job name and, for a few jobs, one value from a closed list. It never sends a command, a path, or a
//     configuration. The inputs a job reads (the reference twin, the requirements, the stages) are held by the server.
//   - Every job runs inside this process by calling the same functions the command-line scripts call. No shell, no child
//     process, no file written to the repository. A job returns plain data, and the page draws it.
//   - Running needs the task:run permission. Every run is written to the audit log, and the history a person sees is the
//     history of their own lab only.
//   - Jobs here read the synthetic reference inputs or a simulated tenant that lives in memory. A job that could reach a
//     real vendor does not belong in this list; it goes through the change workflow with a second person's approval.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { can } from "./roles.mjs";
import { applySequence, checkGraph, loadStages, plan } from "../tools/twin-sequence.mjs";
import { runAgent } from "../tools/health-agent.mjs";
import { evaluate as evaluateAsBuilt, renderReport as renderAsBuiltReport } from "../tools/asbuilt.mjs";
import { buildSnapshot } from "../tools/snapshot.mjs";
import { buildChangeSet, assertHealthy } from "../tools/render-iac.mjs";
import { buildGraph, renderMermaid } from "../tools/render-topology.mjs";
import { runRoundtrip } from "../tools/roundtrip.mjs";
import { sweep, validateScenario } from "../tools/rto-wifi.mjs";
import { runDemoChecks } from "../tools/demo-check.mjs";
import { validateSnapshot } from "../viewer/snapshot.js";
import { snapshotToDrawio } from "../viewer/drawio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), "utf8"));

const MAX_HISTORY = 50;
const MAX_TEXT = 200_000;
const clip = (text) => String(text).slice(0, MAX_TEXT);

// Result blocks. The page draws these with text only, never as markup.
const checks = (items) => ({ type: "checks", items });
const table = (columns, rows) => ({ type: "table", columns, rows });
const text = (value) => ({ type: "text", text: clip(value) });
const file = (name, mime, content) => ({ type: "file", name, mime, text: clip(content) });

/**
 * The journey, in order. A step groups jobs; the page shows one step bar. `steps` and `TASKS` are the only description of
 * what can run.
 */
export const STEPS = [
  { id: "build", title: "Build", about: "See the order the twin is built in and confirm the plan holds together." },
  { id: "verify", title: "Verify", about: "Build the twin stage by stage and confirm every stage's health checks pass." },
  { id: "rehearse", title: "Rehearse", about: "Practise a change on a simulated tenant that lives only in memory, and confirm the whole demo still behaves as the runbook says." },
  { id: "report", title: "Report", about: "Claim against the as-built requirements, with a verdict for each one." },
  { id: "export", title: "Export", about: "Get the diagram out as a draw.io file for draw.io, Lucidchart, or Visio, and preview the changes a build would make." }
];

/**
 * `writes` says what a job changes: "none" reads and reports only. `input` names the single value a job accepts and the closed
 * list it must come from. Run functions receive the server-held inputs and return { ok, headline, blocks }.
 */
export const TASKS = [
  {
    id: "plan", step: "build", title: "Show the build order", writes: "none",
    summary: "Lists the stages in the order they are built, with what each one needs and what it makes.",
    run: ({ stages }) => {
      const ordered = plan(stages);
      return {
        ok: ordered.length === stages.length,
        headline: ordered.length === stages.length ? `${ordered.length} stages, in build order.` : `Only ${ordered.length} of ${stages.length} stages can be ordered; the rest can never run.`,
        blocks: [table(["Order", "Stage", "Needs", "Makes"], ordered.map((st, i) => [i + 1, `${st.id} ${st.title}`, st.requires.join(", ") || "nothing", st.produces.join(", ")]))]
      };
    }
  },
  {
    id: "topology", step: "build", title: "Draw the topology", writes: "none",
    summary: "Draws every device and connection the twin currently describes, as a Mermaid diagram you can paste into documentation.",
    run: ({ config }) => {
      const graph = buildGraph(config);
      const diagram = renderMermaid(config);
      return { ok: graph.nodes.length > 0, headline: `${graph.nodes.length} devices and ${graph.edges.length} connections.`, blocks: [file("topology.mmd", "text/plain", diagram), text(diagram)] };
    }
  },
  {
    id: "check", step: "build", title: "Check the build plan", writes: "none",
    summary: "Looks for stages that need something no stage makes, stages that make the same thing twice, and loops.",
    run: ({ stages }) => {
      const { problems } = checkGraph(stages);
      return {
        ok: problems.length === 0,
        headline: problems.length === 0 ? `${stages.length} stages, and the plan holds together.` : `${problems.length} problem(s) in the build plan.`,
        blocks: [checks(problems.length === 0 ? [{ label: "Dependency graph is consistent", status: "pass" }] : problems.map((p) => ({ label: p, status: "fail" })))]
      };
    }
  },
  {
    id: "verify", step: "verify", title: "Build the twin in order", writes: "none",
    summary: "Applies every stage in the planned order to an empty twin and confirms it reaches the final validation.",
    run: ({ stages }) => {
      const ordered = plan(stages).map((s) => s.id);
      const result = applySequence(stages, ordered);
      const complete = result.ok && ordered.length === stages.length && result.state.includes("validation.passed");
      return {
        ok: complete,
        headline: complete ? "Verified: the twin reaches validation in the planned order." : "Not verified: the twin did not reach validation.",
        blocks: [checks(result.steps.map((s) => ({ label: `Stage ${s.id}`, status: s.status === "applied" || s.status === "already-applied" ? "pass" : "fail", detail: s.status === "refused" ? `missing: ${s.missing.join(", ")}` : s.status === "unknown" ? "no such stage" : `produces: ${(s.produces ?? []).join(", ")}` })))]
      };
    }
  },
  {
    id: "health", step: "verify", title: "Run the stage health checks", writes: "none",
    summary: "Builds the twin stage by stage and runs each stage's checks. It stops at the first stage that fails, so the first problem is the one to fix.",
    input: { name: "until", label: "Stop after stage", choices: ({ stages }) => plan(stages).map((s) => s.id), optional: true },
    run: ({ stages, config }, params) => {
      const report = runAgent({ stages, config, ...(params.until ? { until: params.until } : {}) });
      const blocks = report.stages.map((entry) => checks(entry.checks.map((c) => ({ label: `${entry.stage} ${c.id}`, status: c.ok ? "pass" : "fail", ...(c.ok ? {} : { detail: String(c.message ?? "") }) }))));
      const headline = report.status === "halted" ? `Halted at stage ${report.halted.stage}: ${report.halted.reason}.` : report.status === "healthy-partial" ? `Healthy through stage ${report.through}. Later stages were not checked.` : `Healthy: every stage passed through ${report.through}.`;
      return { ok: report.status !== "halted", headline, blocks };
    }
  },
  {
    id: "roundtrip", step: "rehearse", title: "Rehearse a change and undo it", writes: "simulated",
    summary: "Applies the whole change set to a simulated tenant, then destroys it, and confirms the tenant is exactly as it started and anything it did not create was left alone. Nothing real is touched.",
    run: async ({ config }, _params, { now }) => {
      const r = await runRoundtrip(config, now());
      const items = [
        { label: "The change was planned, applied, and destroyed", status: r.ok ? "pass" : "fail" },
        { label: "The tenant is identical before and after", status: r.symmetric ? "pass" : "fail" },
        { label: "Objects the twin did not create were left alone", status: r.unmanagedSurvived ? "pass" : "fail" }
      ];
      return { ok: Boolean(r.ok && r.symmetric && r.unmanagedSurvived), headline: r.ok ? `${r.created} objects created and ${r.deleted} deleted on the simulated tenant, which ended unchanged.` : "The rehearsal did not complete.", blocks: [checks(items)] };
    }
  },
  {
    id: "demo", step: "rehearse", title: "Check the demo runbook", writes: "none",
    summary: "Runs every step the working-session runbook claims, offline, and says which ones no longer behave as described.",
    run: async () => {
      const rows = await runDemoChecks();
      const failed = rows.filter((r) => !r.ok).length;
      return { ok: failed === 0, headline: failed === 0 ? `All ${rows.length} demo steps behave as the runbook says.` : `${failed} of ${rows.length} demo steps do not match the runbook.`, blocks: [checks(rows.map((r) => ({ label: r.step, status: r.ok ? "pass" : "fail", detail: r.detail })))] };
    }
  },
  {
    id: "rto", step: "report", title: "Return-to-office what-if", writes: "none",
    summary: "Shows what happens to addresses, Wi-Fi, and the internet link as more people come on site each week, and where the first problem appears.",
    run: () => {
      const scenario = load("scenarios", "rto-wifi.json");
      const problems = validateScenario(scenario);
      if (problems.length > 0) return { ok: false, headline: "The scenario is not valid.", blocks: [checks(problems.map((p) => ({ label: p, status: "fail" })))] };
      const rows = sweep(scenario);
      const dhcp = rows.find((r) => r.dhcpStatus === "over");
      const wifi = rows.find((r) => r.zonesOver > 0);
      const first = [dhcp && `address pool at ${dhcp.days} day${dhcp.days === 1 ? "" : "s"} a week`, wifi && `Wi-Fi at ${wifi.days} days a week`].filter(Boolean);
      return {
        ok: true,
        attention: first.length ? `first problem: ${first.join(", then ")}` : null,
        headline: first.length ? `First problems: ${first.join(", then ")}.` : "No problem appears at any office day count.",
        blocks: [table(["Days a week", "People on site (peak)", "Address pool", "Wi-Fi zones over", "Internet link"], rows.map((r) => [r.days, r.peakOnSite, `${r.dhcpStatus} (${Math.round(r.dhcpUtilization * 100)}%)`, r.zonesOver, `${r.wanStatus} (${Math.round(r.wanUtilization * 100)}%)`]))]
      };
    }
  },
  {
    id: "asbuilt", step: "report", title: "As-built claim", writes: "none",
    summary: "Compares the twin with the customer's as-built requirements. Each requirement is Met, Unmet, Indeterminable, Attested, or Needs attestation.",
    run: ({ config, requirements, attestations }) => {
      const result = evaluateAsBuilt({ requirements, config, attestations });
      const c = result.claim.counts;
      return {
        // The job ran and produced a claim, so it succeeded. An unmet requirement is a finding for a person, not a failed job.
        ok: true,
        attention: c.unmet > 0 ? `${c.unmet} requirement${c.unmet === 1 ? " is" : "s are"} unmet` : null,
        headline: `${c.met} met, ${c.unmet} unmet, ${c.indeterminable} indeterminable, ${c.attested} attested, ${c.needs_attestation} need attestation (of ${c.total}).`,
        blocks: [
          table(["Requirement", "Verdict", "Why"], result.results.map((r) => [r.id, r.verdict, r.reason])),
          file("asbuilt-report.md", "text/markdown", renderAsBuiltReport(result))
        ]
      };
    }
  },
  {
    id: "iac-preview", step: "export", title: "Preview the changes a build would make", writes: "none",
    summary: "Lists every object the build would create, by vendor, and gives you the change set as a file. It only shows the list; it writes no Terraform and applies nothing.",
    run: ({ config }) => {
      try { assertHealthy(config); } catch { return { ok: false, headline: "The twin is not healthy, so no change set was made. Run the stage health checks first.", blocks: [] }; }
      const ops = buildChangeSet(config);
      return { ok: true, headline: `${ops.length} objects would be created across ${new Set(ops.map((o) => o.vendor)).size} vendors.`, blocks: [table(["Vendor", "Object", "Name", "Action"], ops.map((o) => [o.vendor, o.object, o.name, o.action])), file("changeset.json", "application/json", `${JSON.stringify(ops, null, 2)}\n`)] };
    }
  },
  {
    id: "drawio", step: "export", title: "Export the diagram", writes: "none",
    summary: "Makes a draw.io file of the current topology. Open it in draw.io, import it into Lucidchart, or export it to Visio.",
    run: async ({ config }, _params, { now }) => {
      const snapshot = await buildSnapshot(config, { snapshotId: "EXPORT", capturedAt: now().toISOString().replace(/\.\d+Z$/, "Z"), label: "Export" });
      const problems = validateSnapshot(snapshot);
      if (problems.length > 0) return { ok: false, headline: "The topology could not be exported.", blocks: [checks(problems.map((p) => ({ label: p, status: "fail" })))] };
      return { ok: true, headline: `Diagram ready: ${snapshot.topology.nodes.length} devices and ${snapshot.topology.edges.length} connections.`, blocks: [file("twin-topology.drawio", "application/vnd.jgraph.mxfile", snapshotToDrawio(snapshot))] };
    }
  }
];

const TASK_BY_ID = new Map(TASKS.map((t) => [t.id, t]));

/**
 * @param {{ audit: { record: Function }, now?: () => Date, inputs?: object, jobs?: object[] }} deps
 *   `inputs` replaces the reference inputs, for tests. `jobs` replaces the job list, for tests.
 */
export function createTasks({ audit, now = () => new Date(), inputs = null, jobs = TASKS }) {
  const byId = jobs === TASKS ? TASK_BY_ID : new Map(jobs.map((t) => [t.id, t]));
  const history = new Map(); // labId -> newest first
  const running = new Set(); // `${labId}:${taskId}`
  let counter = 0;
  const base = inputs ?? {
    stages: loadStages(),
    config: load("config", "twin-config.json"),
    requirements: load("requirements", "example-asbuilt.json"),
    attestations: load("requirements", "example-attestations.json")
  };
  const lab = (user) => (typeof user.labId === "string" && user.labId !== "" ? user.labId : null);
  const choicesOf = (task) => (task.input ? task.input.choices(base) : []);

  return {
    steps: () => STEPS.map((s) => ({ ...s })),
    /** What can run, and the latest result of each job in this lab. */
    list(user) {
      const labId = lab(user);
      if (!labId) return null;
      const mine = history.get(labId) ?? [];
      return [...byId.values()].map((t) => {
        const last = mine.find((r) => r.taskId === t.id) ?? null;
        return { id: t.id, step: t.step, title: t.title, summary: t.summary, writes: t.writes, input: t.input ? { name: t.input.name, label: t.input.label, choices: choicesOf(t), optional: t.input.optional === true } : null, last: last ? { runId: last.runId, ok: last.ok, attention: last.attention, at: last.at, by: last.by } : null };
      });
    },
    history(user) { const labId = lab(user); return labId ? (history.get(labId) ?? []).map(({ blocks, ...rest }) => rest) : null; },
    get(user, runId) { const labId = lab(user); return labId ? ((history.get(labId) ?? []).find((r) => r.runId === runId) ?? null) : null; },

    async run(user, taskId, params = {}) {
      const labId = lab(user);
      if (!can(user.roles, "task:run")) { await audit.record({ event: "denied", actor: user.subject, permission: "task:run" }); return { ok: false, code: "forbidden" }; }
      if (!labId) return { ok: false, code: "not_found" };
      const task = typeof taskId === "string" ? byId.get(taskId) : undefined;
      if (!task) return { ok: false, code: "not_found" };
      if (params === null || typeof params !== "object" || Array.isArray(params)) return { ok: false, code: "invalid_input" };
      // One closed value at most, and it has to be on the job's own list. Anything else is refused, not ignored.
      const allowed = task.input ? [task.input.name] : [];
      if (Object.keys(params).some((k) => !allowed.includes(k))) return { ok: false, code: "invalid_input" };
      let clean = {};
      if (task.input && params[task.input.name] !== undefined && params[task.input.name] !== "") {
        const value = params[task.input.name];
        if (typeof value !== "string" || !choicesOf(task).includes(value)) return { ok: false, code: "invalid_input" };
        clean = { [task.input.name]: value };
      }
      const key = `${labId}:${task.id}`;
      if (running.has(key)) return { ok: false, code: "already_running" };
      running.add(key);
      const started = now();
      let outcome;
      try {
        outcome = await task.run(base, clean, { now });
      } catch {
        // The reason is not passed on: an internal failure message can name paths or inputs.
        outcome = { ok: false, headline: "The job could not finish.", blocks: [] };
      } finally { running.delete(key); }
      counter += 1;
      const record = { runId: `RUN-${String(counter).padStart(6, "0")}`, taskId: task.id, title: task.title, ok: outcome.ok === true, headline: String(outcome.headline ?? ""), attention: typeof outcome.attention === "string" ? outcome.attention.slice(0, 200) : null, at: started.toISOString(), by: user.subject, input: clean, blocks: outcome.blocks ?? [] };
      const mine = history.get(labId) ?? [];
      mine.unshift(record);
      history.set(labId, mine.slice(0, MAX_HISTORY));
      await audit.record({ event: "task.run", actor: user.subject, task: task.id, ok: record.ok, run: record.runId });
      return { ok: true, run: record };
    }
  };
}
