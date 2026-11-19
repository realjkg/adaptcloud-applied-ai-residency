// Guarded provisioning engine: plan, apply, destroy.
//
// Rules the engine keeps, whatever transport it is given:
//   - Nothing is written until policy, digest, approval, and a full read of current state have all passed.
//   - It only ever deletes objects it owns. A same-named object it does not own is a conflict, never adopted or removed.
//   - Every write is read back and compared with intent. A mismatch halts the run.
//   - A halted apply rolls back only what that run created, in reverse order.
//   - The audit trail records vendor, object, name, and outcome. It never records attribute values.
//
// Only the in-memory simulator exists. There is no live transport; see docs/PROVISIONING.md.

import { buildChangeSet, assertHealthy } from "./render-iac.mjs";
import { digestOf, evaluatePolicy, stableStringify, validateApproval } from "./provision-policy.mjs";

const refuse = (refusal, detail) => ({ ok: false, refusal, ...(detail ? { detail } : {}) });
const keyOf = (op) => ({ vendor: op.vendor, object: op.object, name: op.name });
const same = (a, b) => stableStringify(a) === stableStringify(b);

/** Builds the change set from a config, but only if every stage is healthy. */
export function prepare(config) {
  try {
    assertHealthy(config);
  } catch (error) {
    return refuse("config_unhealthy", error.message);
  }
  const changeset = buildChangeSet(config);
  return { ok: true, changeset, digest: digestOf(changeset) };
}

async function classify(changeset, transport, owner) {
  const entries = [];
  for (const op of changeset) {
    const existing = await transport.read(keyOf(op));
    let state = "create";
    if (existing) {
      if (existing.managedBy !== owner) state = "conflict_unmanaged";
      else state = same(existing.attributes, op.attributes) ? "unchanged" : "drift";
    }
    entries.push({ order: op.order, vendor: op.vendor, object: op.object, name: op.name, state });
  }
  return entries;
}

/** Dry run: reads current state, writes nothing, and returns the digest an approval must be bound to. */
export async function plan({ changeset, transport, policy, target, killSwitch = false }) {
  const reason = evaluatePolicy({ action: "plan", policy, target, changeset, transportKind: transport.kind, killSwitch });
  if (reason) return refuse(reason);
  const entries = await classify(changeset, transport, target.owner);
  const summary = {};
  for (const entry of entries) summary[entry.state] = (summary[entry.state] ?? 0) + 1;
  return { ok: true, digest: digestOf(changeset), entries, summary };
}

async function rollback(created, transport, owner, audit, now, action) {
  const remaining = [];
  for (const op of [...created].reverse()) {
    const result = await transport.delete(keyOf(op), owner);
    audit.push({ at: now.toISOString(), action: `${action}-rollback`, order: op.order, vendor: op.vendor, object: op.object, name: op.name, outcome: result.ok ? result.outcome : result.reason });
    if (!result.ok) remaining.push({ order: op.order, vendor: op.vendor, object: op.object, name: op.name, reason: result.reason });
  }
  return { complete: remaining.length === 0, remaining };
}

export async function apply({ changeset, transport, policy, target, approval, plannedDigest, now, killSwitch = false }) {
  const audit = [];
  const reason = evaluatePolicy({ action: "apply", policy, target, changeset, transportKind: transport.kind, killSwitch });
  if (reason) return refuse(reason);

  const digest = digestOf(changeset);
  if (plannedDigest !== digest) return refuse("dry_run_required", "run plan on this exact change set and pass its digest");
  const approvalReason = validateApproval(approval, { action: "apply", tenantId: target.tenantId, digest, now });
  if (approvalReason) return refuse(approvalReason);

  // Read everything first. Any conflict or drift stops the run before the first write.
  const entries = await classify(changeset, transport, target.owner);
  if (entries.some((entry) => entry.state === "conflict_unmanaged")) return refuse("conflict_unmanaged", "an object with a planned name exists and is not owned by this twin");
  if (entries.some((entry) => entry.state === "drift")) return refuse("drift_detected", "an owned object differs from intent; review before applying");

  const created = [];
  const unchanged = [];
  for (const op of changeset) {
    const state = entries.find((entry) => entry.order === op.order).state;
    const row = { at: now.toISOString(), action: "apply", order: op.order, vendor: op.vendor, object: op.object, name: op.name };
    if (state === "unchanged") {
      unchanged.push(op);
      audit.push({ ...row, outcome: "unchanged" });
      continue;
    }
    // The operation joins the rollback list before it runs. A create that fails partway may still have left
    // something behind, and deleting a name that is not there, or not ours, is safe.
    created.push(op);
    try {
      await transport.create(keyOf(op), op.attributes, target.owner);
    } catch {
      audit.push({ ...row, outcome: "operation_failed" });
      return { ...refuse("operation_failed", `stage ${op.stage}`), audit, rolledBack: await rollback(created, transport, target.owner, audit, now, "apply") };
    }
    let readBack = null;
    try {
      readBack = await transport.read(keyOf(op));
    } catch {
      readBack = null;
    }
    if (!readBack || !same(readBack.attributes, op.attributes)) {
      audit.push({ ...row, outcome: "verification_failed" });
      return { ...refuse("verification_failed", `stage ${op.stage}`), audit, rolledBack: await rollback(created, transport, target.owner, audit, now, "apply") };
    }
    audit.push({ ...row, outcome: "created" });
  }
  return { ok: true, digest, created: created.length, unchanged: unchanged.length, audit };
}

export async function destroy({ changeset, transport, policy, target, approval, now, killSwitch = false }) {
  const audit = [];
  const reason = evaluatePolicy({ action: "destroy", policy, target, changeset, transportKind: transport.kind, killSwitch });
  if (reason) return refuse(reason);

  const digest = digestOf(changeset);
  const approvalReason = validateApproval(approval, { action: "destroy", tenantId: target.tenantId, digest, now });
  if (approvalReason) return refuse(approvalReason);

  let deleted = 0;
  const skipped = [];
  for (const op of [...changeset].reverse()) {
    const row = { at: now.toISOString(), action: "destroy", order: op.order, vendor: op.vendor, object: op.object, name: op.name };
    const result = await transport.delete(keyOf(op), target.owner);
    if (result.ok && result.outcome === "deleted") {
      deleted += 1;
      audit.push({ ...row, outcome: "deleted" });
    } else if (result.ok) {
      audit.push({ ...row, outcome: "not_found" });
    } else if (result.reason === "unmanaged_object") {
      // Never delete what this twin does not own. Leave it and say so.
      skipped.push({ order: op.order, vendor: op.vendor, object: op.object, name: op.name });
      audit.push({ ...row, outcome: "skipped_unmanaged" });
    } else {
      audit.push({ ...row, outcome: result.reason });
      return { ...refuse("in_use", `${op.object} ${op.name} is still referenced`), audit, deleted, skipped };
    }
  }
  return { ok: true, deleted, skipped, audit };
}
