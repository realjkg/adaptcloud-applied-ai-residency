// Target-based write workflow for Palo Alto and Meraki (live or simulated). Authorization is per execution, not a switch:
// enabling an adapter authorizes nothing.
//
//   request   an operator names an allowlisted target id, a change type, and the change's fields. The server resolves the
//             target, reads current state, and builds a dry-run diff. The plan has an id, an expiry, and a digest over the
//             exact target, change type, change, baseline, proposed state, and commit scope.
//   approve   a different approver sees the diff and commit scope and approves that digest, before it expires.
//   execute   immediately before writing, the server re-checks the operator's role, the target and change type still being
//             allowed, the approval, the kill switch, and drift. A changed baseline marks the plan stale and requires a new
//             plan and approval. Executing twice returns the first outcome and never writes twice.
//   rollback  a new request, with its own plan and approval, built from the original. It is refused if the object or rule
//             it would remove is not the one this system created, so someone else's later edit is never overwritten.
//
// Operations are written to disk after each step. An operation found "executing" after a restart is marked uncertain,
// not re-run.

import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { digest, markFor, OPID, same } from "./adapters/common.mjs";
import { can } from "./roles.mjs";

const deny = (code, extra = {}) => ({ ok: false, code, ...extra });
export const PLAN_TTL_MS = 30 * 60_000;
const TERMINAL = new Set(["completed", "failed", "uncertain", "rejected", "stale", "expired"]);

export function createOperations({ targets, adapters, adapterFor = (t) => adapters?.[t.vendor], audit, now = () => new Date(), killSwitch = () => false, planTtlMs = PLAN_TTL_MS, liveAuthorized = () => true, transportKind, file = null }) {
  const ops = new Map();
  const inflight = new Map();
  let saving = Promise.resolve();
  const save = () => {
    if (!file) return;
    saving = saving.then(async () => { await writeFile(`${file}.tmp`, JSON.stringify([...ops.values()])); await rename(`${file}.tmp`, file); }).catch(() => {});
    return saving;
  };
  const ready = (async () => {
    if (!file) return;
    try {
      for (const op of JSON.parse(await readFile(file, "utf8"))) {
        if (op.status === "executing") { op.status = "uncertain"; op.result = { outcome: "uncertain", reason: "service_restarted_during_write" }; }
        ops.set(op.id, op);
      }
    } catch { /* first run */ }
  })();

  const view = (op) => ({
    id: op.id, targetId: op.targetId, vendor: op.vendor, changeType: op.changeType, params: op.params, status: op.status,
    requester: op.requester.name, requestedAt: op.requestedAt, expiresAt: op.expiresAt, planDigest: op.planDigest,
    diff: op.plan.diff, blockers: op.plan.blockers, commitScope: op.plan.commitScope, requiresExclusiveWindow: op.plan.requiresExclusiveWindow,
    approver: op.approval?.approverName ?? null, exclusiveWindowConfirmed: op.approval?.exclusiveWindow === true,
    result: op.result ?? null, rollbackOf: op.rollbackOf ?? null, transport: transportKind
  });

  const resolve = (targetId, changeType) => {
    const target = targets.get(targetId);
    if (!target) return { code: "target_not_allowlisted" };
    if (!target.changeTypes.includes(changeType)) return { code: "change_type_not_allowed_for_target" };
    const adapter = adapterFor(target);
    const def = adapter?.changeTypes?.[changeType];
    if (!def) return { code: "change_type_unsupported" };
    return { target, adapter, def };
  };

  async function createPlan(user, { targetId, changeType, params, rollbackOf = null, before }) {
    const r = resolve(targetId, changeType);
    if (r.code) return deny(r.code);
    if (r.def.rollbackOnly && !rollbackOf) return deny("rollback_only");
    if (typeof params !== "object" || params === null || Array.isArray(params)) return deny("params_invalid");
    const problems = r.def.validate(params);
    if (problems.length) return deny("params_invalid", { detail: problems.join("; ") });
    const id = `OP-${randomBytes(5).toString("hex").toUpperCase()}`;
    let plan;
    try { plan = await r.adapter.plan({ changeType, params, opId: id, target: r.target }); } catch (error) { return deny("plan_failed", { detail: String(error?.code ?? "read_failed").slice(0, 60) }); }
    if (plan.blockers.length) { await audit.record({ event: "operation.refused", actor: user.subject, target: targetId, changeType, blockers: plan.blockers.join(",") }); return deny("blocked", { blockers: plan.blockers }); }
    const requestedAt = now();
    const op = {
      id, targetId, vendor: r.target.vendor, changeType, params, requester: { subject: user.subject, name: user.name }, requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + planTtlMs).toISOString(), status: "pending_approval", plan, rollbackOf, previousValue: plan.previousValue ?? before,
      baselineDigest: digest(plan.baseline)
    };
    op.planDigest = digest({ targetId, vendor: op.vendor, changeType, params, baseline: op.baselineDigest, proposed: digest(plan.proposed), commitScope: plan.commitScope ?? null, exclusive: plan.requiresExclusiveWindow });
    ops.set(id, op);
    await save();
    await audit.record({ event: "operation.requested", operation: id, actor: user.subject, target: targetId, changeType, digest: op.planDigest, ...(rollbackOf ? { rollbackOf } : {}) });
    return { ok: true, operation: view(op) };
  }

  return {
    ready,
    /** Targets the browser may see. */
    targets: () => [...targets.values()].map((t) => ({ id: t.id, label: t.label, vendor: t.vendor, environment: t.environment ?? "lab", disposable: t.disposable === true, changeTypes: t.changeTypes.map((c) => { const d = adapterFor(t)?.changeTypes?.[c]; return { id: c, label: d?.label ?? c, rollbackOnly: d?.rollbackOnly === true, fields: d?.fields ?? [] }; }).filter((c) => !c.rollbackOnly) })),

    async request(user, body) {
      await ready;
      if (!can(user.roles, "operation:request")) return deny("forbidden");
      if (killSwitch()) return deny("kill_switch_engaged");
      // Only these three fields are read. Any URL, path, or command in the body is ignored, not honored.
      return createPlan(user, { targetId: body?.targetId, changeType: body?.changeType, params: body?.params });
    },

    async decide(user, id, { decision, planDigest, exclusiveWindow } = {}) {
      await ready;
      if (!can(user.roles, "operation:approve")) return deny("forbidden");
      const op = ops.get(id);
      if (!op) return deny("not_found");
      if (op.status !== "pending_approval") return deny("not_pending");
      if (op.requester.subject === user.subject) { await audit.record({ event: "operation.self_approval_refused", operation: id, actor: user.subject }); return deny("self_approval"); }
      if (decision === "reject") { op.status = "rejected"; await save(); await audit.record({ event: "operation.rejected", operation: id, actor: user.subject }); return { ok: true, operation: view(op) }; }
      if (decision !== "approve") return deny("decision_invalid");
      if (now() >= new Date(op.expiresAt)) { op.status = "expired"; await save(); return deny("plan_expired"); }
      if (planDigest !== op.planDigest) return deny("plan_digest_mismatch");
      if (op.plan.requiresExclusiveWindow && exclusiveWindow !== true) return deny("exclusive_window_confirmation_required");
      op.approval = { approver: user.subject, approverName: user.name, at: now().toISOString(), planDigest, exclusiveWindow: exclusiveWindow === true };
      op.status = "approved";
      await save();
      await audit.record({ event: "operation.approved", operation: id, actor: user.subject, digest: planDigest, exclusiveWindow: exclusiveWindow === true });
      return { ok: true, operation: view(op) };
    },

    /** Idempotent: a repeat, or a concurrent call, returns the existing operation and never writes again. */
    async execute(user, id) {
      await ready;
      const op = ops.get(id);
      if (!op) return deny("not_found");
      if (!can(user.roles, "operation:execute")) return deny("forbidden");
      if (TERMINAL.has(op.status) || op.status === "executing") return { ok: op.status === "completed", code: op.status === "completed" ? undefined : "already_" + op.status, operation: view(op), existing: true };
      if (inflight.has(id)) return inflight.get(id);
      const run = (async () => {
        const fail = async (code, status) => { if (status) { op.status = status; await save(); } await audit.record({ event: "operation.execute_refused", operation: id, actor: user.subject, reason: code }); return deny(code, { operation: view(op) }); };
        if (op.status !== "approved") return fail("not_approved");
        if (killSwitch()) return fail("kill_switch_engaged");
        // Re-authorize now, not at approval time.
        const r = resolve(op.targetId, op.changeType);
        if (r.code) return fail(r.code);
        if (transportKind === "live" && !liveAuthorized()) return fail("live_not_authorized");
        if (r.target.environment !== "lab" && transportKind === "live") return fail("environment_not_lab");
        if (op.approval.planDigest !== op.planDigest || op.approval.approver === op.requester.subject) return fail("approval_invalid");
        if (now() >= new Date(op.expiresAt)) return fail("approval_expired", "expired");
        if (op.plan.requiresExclusiveWindow && op.approval.exclusiveWindow !== true) return fail("exclusive_window_not_confirmed");
        let current;
        try { current = await r.adapter.readState({ changeType: op.changeType, params: op.params }); } catch { return fail("baseline_unreadable"); }
        if (digest(current) !== op.baselineDigest) { await audit.record({ event: "operation.drift", operation: id, actor: user.subject }); return fail("drift_detected_new_plan_required", "stale"); }

        op.status = "executing";
        op.executedBy = user.subject;
        await save();
        await audit.record({ event: "operation.executing", operation: id, actor: user.subject, digest: op.planDigest });
        let result;
        try { result = await r.adapter.execute(op.plan, { params: op.params, changeType: op.changeType, target: r.target, onJobQueued: async (jobId) => { op.jobId = jobId; await save(); await audit.record({ event: "operation.commit_queued", operation: id, actor: user.subject, job: jobId }); } }); } catch { result = { outcome: "uncertain", reason: "executor_error" }; }
        op.result = result;
        op.status = result.outcome === "verified" ? "completed" : result.outcome === "failed" ? "failed" : "uncertain";
        await save();
        await audit.record({ event: "operation.executed", operation: id, actor: user.subject, outcome: op.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.stage ? { stage: result.stage } : {}), ...(result.candidateLeftInPlace ? { candidateLeftInPlace: true } : {}) });
        return { ok: op.status === "completed", operation: view(op) };
      })();
      inflight.set(id, run);
      try { return await run; } finally { inflight.delete(id); }
    },

    /** A rollback is a new change: its own plan, its own approval. It is refused if the target no longer holds what this system created. */
    async rollback(user, id) {
      await ready;
      if (!can(user.roles, "operation:request")) return deny("forbidden");
      const op = ops.get(id);
      if (!op) return deny("not_found");
      if (!["completed", "uncertain"].includes(op.status)) return deny("nothing_to_roll_back");
      const r = resolve(op.targetId, op.changeType);
      if (r.code) return deny(r.code);
      const inverse = r.def.inverse?.(op.params, { opId: op.id, before: op.previousValue, created: op.plan.proposed });
      if (!inverse) return deny("no_rollback_for_this_change");
      return createPlan(user, { targetId: op.targetId, changeType: inverse.changeType, params: inverse.params, rollbackOf: op.id });
    },

    get: (id) => (ops.has(id) ? view(ops.get(id)) : null),
    list: () => [...ops.values()].map(view).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    markFor, OPID, same
  };
}
