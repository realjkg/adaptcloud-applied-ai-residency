// Default-deny policy for provisioning. Pure functions: no I/O, no clock, no network.
// Every refusal is a specific machine-readable reason so a refusal can be audited, not guessed at.

import { createHash } from "node:crypto";

export const REASONS = [
  "layer_disabled",
  "kill_switch_engaged",
  "environment_not_lab",
  "tenant_not_allowlisted",
  "wildcard_not_permitted",
  "vendor_not_allowlisted",
  "transport_unavailable",
  "too_many_operations",
  "destroy_not_enabled",
  "config_unhealthy",
  "dry_run_required",
  "approval_required",
  "approval_invalid",
  "approval_not_yet_valid",
  "approval_expired",
  "approval_scope_mismatch",
  "approval_digest_mismatch",
  "conflict_unmanaged",
  "drift_detected",
  "operation_failed",
  "verification_failed",
  "in_use"
];

const HOUR = 60 * 60 * 1000;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** JSON with sorted keys, so the same change set always yields the same digest. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const digestOf = (changeset) => createHash("sha256").update(stableStringify(changeset)).digest("hex");

/**
 * Returns a refusal reason, or null when the action may proceed.
 * Order: layer switch, kill switch, environment, tenant, wildcard, vendor, transport, size, destroy.
 * `action` is "plan", "apply", or "destroy". Production-like environments are refused by construction:
 * the only environment this layer will ever act on is "lab".
 */
export function evaluatePolicy({ action, policy, target, changeset, transportKind, killSwitch = false }) {
  if (!policy || policy.enabled !== true) return "layer_disabled";
  if (killSwitch === true) return "kill_switch_engaged";
  if (policy.environment !== "lab" || target?.environment !== "lab") return "environment_not_lab";

  const tenants = Array.isArray(policy.allowedTenants) ? policy.allowedTenants : [];
  const vendors = Array.isArray(policy.allowedVendors) ? policy.allowedVendors : [];
  if ([...tenants, ...vendors].some((entry) => typeof entry === "string" && entry.includes("*"))) return "wildcard_not_permitted";
  if (typeof target?.tenantId !== "string" || !tenants.includes(target.tenantId)) return "tenant_not_allowlisted";
  if (!changeset.every((op) => vendors.includes(op.vendor))) return "vendor_not_allowlisted";

  // Only the simulator exists. A live adapter needs owner approval, a threat model, and a passing contract suite.
  if (policy.transport !== "simulator" || transportKind !== "simulator") return "transport_unavailable";
  if (!Number.isInteger(policy.maxOperations) || changeset.length > policy.maxOperations) return "too_many_operations";
  if (action === "destroy" && policy.allowDestroy !== true) return "destroy_not_enabled";
  return null;
}

/**
 * An approval is a human's decision for one action, one tenant, and one exact change set (by digest).
 * It is bounded at both ends: not from the future, and no older than 24 hours.
 * This checks the binding. It does not authenticate the approver; a real deployment needs signed approvals.
 */
export function validateApproval(approval, { action, tenantId, digest, now }) {
  if (approval === undefined || approval === null) return "approval_required";
  const shapeOk = typeof approval === "object"
    && typeof approval.ref === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(approval.ref)
    && typeof approval.approver === "string" && approval.approver.length > 0
    && typeof approval.action === "string" && typeof approval.tenantId === "string" && typeof approval.digest === "string"
    && typeof approval.approvedAt === "string" && ISO_WITH_OFFSET.test(approval.approvedAt);
  if (!shapeOk) return "approval_invalid";
  const approvedAt = Date.parse(approval.approvedAt);
  if (Number.isNaN(approvedAt)) return "approval_invalid";
  if (approvedAt > now.getTime()) return "approval_not_yet_valid";
  if (now.getTime() - approvedAt > 24 * HOUR) return "approval_expired";
  if (approval.action !== action || approval.tenantId !== tenantId) return "approval_scope_mismatch";
  if (approval.digest !== digest) return "approval_digest_mismatch";
  return null;
}
