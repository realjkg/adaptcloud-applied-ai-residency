// Live readiness: three separate verdicts that never stand in for each other.
//
//   storage    a two-task check on the journal volume: the second task, started after the first has stopped, must recover the
//              first's job id and still refuse a second intent. Counts as verified only when the runner ran on the deployed
//              volume. A local-directory run is reported as simulated and never as verified storage.
//   preflight  read-only checks of a registered target: appliance identity and the read shapes planning relies on. It does not
//              exercise a commit job reply and never authorizes a write.
//   round trip computed from operations that already happened through the normal request, approval, and execution flow: a
//              verified create and a freshly planned, separately approved destroy of it.
//
// This module cannot provision storage, edit targets, approve, execute, or retry anything. Starting a check needs the admin
// role. Results are tied to the deployment (and, for preflight, to the target fingerprint), so a changed deployment or a
// repointed alias makes the old result stale.

import { writeFile, readFile, rename } from "node:fs/promises";
import { can } from "./roles.mjs";

const deny = (code) => ({ ok: false, code });

/**
 * @param {object} options
 * @param {string} options.deploymentId identifies this deployment; results from another one do not count
 * @param {{kind: string, run: () => Promise<{tasks: object[]}>}|null} options.storageRunner
 *   kind "ecs-efs" means the checks ran as separate tasks on the deployed volume; any other kind is a simulation
 * @param {object} options.operations the operations service
 */
export function createReadiness({ deploymentId, storageRunner = null, operations, audit, now = () => new Date(), file = null }) {
  let storage = null;
  let running = false;
  const preflights = new Map();
  const ready = (async () => {
    if (!file) return;
    try { const saved = JSON.parse(await readFile(file, "utf8")); storage = saved.storage ?? null; for (const [k, v] of Object.entries(saved.preflights ?? {})) preflights.set(k, v); } catch { /* first run */ }
  })();
  let saving = Promise.resolve();
  const save = () => { if (file) saving = saving.then(async () => { await writeFile(`${file}.tmp`, JSON.stringify({ storage, preflights: Object.fromEntries(preflights) })); await rename(`${file}.tmp`, file); }).catch(() => {}); return saving; };

  const storageView = () => {
    if (!storage) return { status: "not_run", detail: storageRunner ? "No storage check has been run for this deployment." : "No storage check runner is configured for this deployment." };
    if (storage.deploymentId !== deploymentId) return { status: "stale", detail: "The last check was for a different deployment.", checkedAt: storage.checkedAt };
    return { status: storage.status, kind: storage.kind, simulated: storage.kind !== "ecs-efs", checkedAt: storage.checkedAt, tasks: storage.tasks, detail: storage.detail };
  };

  return {
    ready,
    async state(user, aliases) {
      await ready;
      const rows = [];
      for (const alias of aliases) {
        const pre = preflights.get(alias);
        const r = await operations.preflightKey?.(user, alias);
        const fp = r?.fingerprint ?? null;
        const fresh = pre && fp && pre.fingerprint === fp;
        rows.push({
          alias,
          preflight: !pre ? { status: "not_run" } : !fresh ? { status: "stale", detail: "The target's scope changed since the last preflight.", checkedAt: pre.checkedAt } : { status: pre.passed ? "verified" : "failed", simulated: pre.simulated, checkedAt: pre.checkedAt, checks: pre.checks, notExercised: pre.notExercised },
          roundTrip: fp ? operations.roundTrip(user, alias) : { state: "not_started" }
        });
      }
      return {
        deploymentId,
        storage: storageView(),
        targets: rows,
        // Each verdict stands alone. None of them authorizes a write.
        notice: "A storage result says nothing about the firewall. A preflight says nothing about a commit and never authorizes a write. Only an approved round trip shows a commit end to end."
      };
    },

    async runStorageCheck(user) {
      await ready;
      if (!can(user.roles, "readiness:run")) return deny("forbidden");
      if (!storageRunner) return deny("runner_not_configured");
      if (running) return deny("already_running");
      running = true;
      await audit.record({ event: "readiness.storage_started", actor: user.subject, runner: storageRunner.kind });
      try {
        let out;
        try { out = await storageRunner.run(); } catch { out = { tasks: [], error: "runner_failed" }; }
        const [first, second] = out.tasks ?? [];
        const recovered = second?.checks?.find((c) => /survived task replacement/.test(c.name))?.pass === true;
        const refused = second?.checks?.find((c) => /cannot record a second intent/.test(c.name))?.pass === true;
        const separate = Boolean(first?.id && second?.id && first.id !== second.id);
        const pass = out.tasks?.length === 2 && first.ok === true && second.ok === true && recovered && refused && separate;
        storage = {
          deploymentId, kind: storageRunner.kind, checkedAt: now().toISOString(), status: pass ? (storageRunner.kind === "ecs-efs" ? "verified" : "simulated_only") : "failed",
          tasks: (out.tasks ?? []).map((t) => ({ id: t.id, role: t.role, ok: t.ok === true, checks: t.checks ?? [] })),
          detail: pass ? (storageRunner.kind === "ecs-efs" ? "The second task recovered the first task's job id and refused a second intent." : "Local simulation only. This is not evidence about the deployed volume.") : (out.error ?? (separate ? "The second task did not recover the first task's job id or refused wrongly." : "Two separate tasks did not both complete."))
        };
        await save();
        await audit.record({ event: "readiness.storage_finished", actor: user.subject, outcome: storage.status });
        return { ok: true, storage: storageView() };
      } finally { running = false; }
    },

    async runPreflight(user, alias) {
      await ready;
      if (!can(user.roles, "readiness:run")) return deny("forbidden");
      const r = await operations.preflight(user, alias);
      if (!r.ok) return r;
      preflights.set(alias, { fingerprint: r.fingerprint, passed: r.passed, simulated: r.simulated, checks: r.checks, notExercised: r.notExercised, checkedAt: now().toISOString() });
      await save();
      await audit.record({ event: "readiness.preflight", actor: user.subject, target: alias, outcome: r.passed ? "passed" : "failed" });
      return { ok: true, preflight: { status: r.passed ? "verified" : "failed", simulated: r.simulated, checks: r.checks, notExercised: r.notExercised } };
    }
  };
}
