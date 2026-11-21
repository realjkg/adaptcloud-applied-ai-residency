// Write controls: change requests that go through the guarded provisioning gate. This module is the workflow around
// it; every refusal the gate makes still stands.
//
//   request  an operator proposes a config and a scope (exact vendor/object pairs, apply or destroy)
//            -> the health gate runs, a dry run reads current state, and the digest is recorded
//   approve  a different person with the approver role approves exactly that digest. Nobody approves their own request.
//   apply    an operator applies it. The gate checks policy, digest, approval age, current state, read-back, rollback.
//
// A request, an approval, and a result are all audited with the signed-in identity. Credentials are never stored here.

import { randomBytes } from "node:crypto";
import { apply, destroy, plan, prepare, selectChangeSet } from "../tools/provision.mjs";
import { digestOf } from "../tools/provision-policy.mjs";
import { digest as hashOf } from "./adapters/common.mjs";
import { buildChangeSet } from "../tools/render-iac.mjs";
import { can } from "./roles.mjs";

const MAX_CONFIG_BYTES = 200_000;
const deny = (code) => ({ ok: false, code });

export function createChangeService({ transport: sharedTransport, transportFor = null, access = null, policy, tenantId, owner, baseline, audit, now = () => new Date(), killSwitch = () => false, planTtlMs = 30 * 60_000 }) {
  const changes = new Map();
  const id = () => `CHG-${randomBytes(5).toString("hex").toUpperCase()}`;
  const target = { environment: policy.environment, tenantId, owner };
  // The lab (or "live") comes from the authenticated session on the server, never from the request. Each lab gets its own
  // simulated tenant, so one lab's apply is never another lab's baseline. A principal outside the lab sees nothing in it.
  const transportOf = (ctx) => (transportFor ? transportFor(ctx) : sharedTransport);
  const member = (user) => typeof user?.labId === "string" && access?.member?.({ principalId: user.subject, contextId: user.labId }) === true;
  const visible = (user, c) => member(user) && c.contextId === user.labId;
  const view = (c) => ({ id: c.id, planDigest: c.planDigest, expiresAt: c.expiresAt, action: c.action, selectors: c.selectors, requester: c.requester.name, requestedAt: c.requestedAt, status: c.status, digest: c.digest, summary: c.summary, entries: c.entries, approver: c.approver?.name ?? null, result: c.result ?? null, transport: transportOf(c.contextId).kind });

  return {
    /** The controls a request may target: every vendor and object kind in the change set, and whether the transport can perform it. */
    controls(user) {
      if (!member(user)) return [];
      const transport = transportOf(user.labId);
      const set = buildChangeSet(baseline());
      const seen = new Map();
      for (const op of set) {
        const key = `${op.vendor}/${op.object}`;
        if (!seen.has(key)) seen.set(key, { selector: key, vendor: op.vendor, object: op.object, writable: typeof transport.supports !== "function" || transport.supports(op) === true });
      }
      return [...seen.values()];
    },

    async request(user, { action, selectors, config }) {
      if (!member(user)) return deny("forbidden");
      if (!can(user.roles, "change:request")) return deny("forbidden");
      const transport = transportOf(user.labId);
      if (killSwitch()) return deny("kill_switch");
      if (!["apply", "destroy"].includes(action)) return deny("action_invalid");
      if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 40) return deny("selectors_invalid");
      let proposed = baseline();
      if (config !== undefined) {
        if (typeof config !== "object" || config === null || Array.isArray(config) || JSON.stringify(config).length > MAX_CONFIG_BYTES) return deny("config_invalid");
        proposed = config;
      }
      const prepared = prepare(proposed);
      if (!prepared.ok) return { ok: false, code: prepared.refusal, detail: prepared.detail };
      let changeset;
      try { changeset = selectChangeSet(prepared.changeset, selectors); } catch { return deny("selectors_invalid"); }
      const planned = await plan({ changeset, transport, policy, target, killSwitch: killSwitch() });
      if (!planned.ok) return { ok: false, code: planned.refusal, detail: planned.detail };
      const c = { id: id(), action, selectors: [...selectors].sort(), requester: { subject: user.subject, name: user.name }, requestedAt: now().toISOString(), contextId: user.labId, status: "pending_approval", changeset, digest: planned.digest, summary: planned.summary, entries: planned.entries };
      // The approval binds the change set and the state it was planned against. A different state needs a new plan.
      c.baselineDigest = hashOf(planned.entries);
      c.planDigest = hashOf({ digest: c.digest, baseline: c.baselineDigest, action, scope: c.selectors });
      c.expiresAt = new Date(now().getTime() + planTtlMs).toISOString();
      changes.set(c.id, c);
      await audit.record({ event: "change.requested", change: c.id, actor: user.subject, action, scope: c.selectors.join(","), digest: c.digest });
      return { ok: true, change: view(c) };
    },

    async decide(user, changeId, decision, planDigest) {
      // A change from another lab answers exactly like an unknown id, and nothing else happens.
      const c = changes.get(changeId);
      if (!c || !visible(user, c)) return deny("not_found");
      if (!can(user.roles, "change:approve")) return deny("forbidden");
      if (c.status !== "pending_approval") return deny("not_pending");
      if (c.requester.subject === user.subject) return deny("self_approval");
      if (decision !== "approve" && decision !== "reject") return deny("decision_invalid");
      if (decision === "approve" && now() >= new Date(c.expiresAt)) { c.status = "expired"; return deny("plan_expired"); }
      if (decision === "approve" && planDigest !== c.planDigest) return deny("plan_digest_mismatch");
      if (decision === "reject") {
        c.status = "rejected";
        await audit.record({ event: "change.rejected", change: c.id, actor: user.subject });
        return { ok: true, change: view(c) };
      }
      c.approver = { subject: user.subject, name: user.name };
      c.approval = { ref: `${c.id}-${randomBytes(3).toString("hex").toUpperCase()}`, approver: user.name, action: c.action, tenantId, digest: c.digest, approvedAt: now().toISOString() };
      c.status = "approved";
      await audit.record({ event: "change.approved", change: c.id, actor: user.subject, digest: c.digest });
      return { ok: true, change: view(c) };
    },

    async execute(user, changeId) {
      const c = changes.get(changeId);
      if (!c || !visible(user, c)) return deny("not_found");
      if (!can(user.roles, "change:apply")) return deny("forbidden");
      const transport = transportOf(c.contextId);
      // A repeat, or a concurrent call, returns what already happened and never writes again.
      if (["completed", "failed", "executing", "stale", "expired"].includes(c.status)) return { ok: c.status === "completed", code: c.status === "completed" ? undefined : `already_${c.status}`, change: view(c), existing: true };
      if (c.status !== "approved") return deny("not_approved");
      if (now() >= new Date(c.expiresAt)) { c.status = "expired"; await audit.record({ event: "change.expired", change: c.id, actor: user.subject }); return { ok: false, code: "approval_expired", change: view(c) }; }
      c.status = "executing";
      // Immediately before writing: is the target still in the state the plan was made against?
      const fresh = await plan({ changeset: c.changeset, transport, policy, target, killSwitch: killSwitch() });
      if (fresh.ok && hashOf(fresh.entries) !== c.baselineDigest) {
        c.status = "stale";
        await audit.record({ event: "change.drift", change: c.id, actor: user.subject });
        return { ok: false, code: "drift_detected_new_plan_required", change: view(c) };
      }
      const common = { changeset: c.changeset, transport, policy, target, approval: c.approval, now: now(), killSwitch: killSwitch() };
      const replan = await plan({ changeset: c.changeset, transport, policy, target, killSwitch: killSwitch() });
      const result = !replan.ok ? replan : c.action === "apply" ? await apply({ ...common, plannedDigest: replan.digest }) : await destroy(common);
      c.status = result.ok ? "completed" : "failed";
      c.result = result.ok ? { ok: true, created: result.created ?? 0, unchanged: result.unchanged ?? 0, deleted: result.deleted ?? 0, skipped: (result.skipped ?? []).length } : { ok: false, refusal: result.refusal, rolledBack: result.rolledBack?.complete ?? null };
      await audit.record({ event: "change.executed", change: c.id, actor: user.subject, outcome: c.status, ...(result.ok ? {} : { refusal: result.refusal }) });
      return { ok: result.ok, change: view(c) };
    },

    get: (user, changeId) => (changes.has(changeId) && visible(user, changes.get(changeId)) ? view(changes.get(changeId)) : null),
    list: (user) => (member(user) ? [...changes.values()].filter((c) => visible(user, c)).map(view).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) : []),
    digestOf
  };
}
