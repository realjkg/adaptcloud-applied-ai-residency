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
  "in_use",
  "live_not_authorized",
  "host_not_allowlisted",
  "object_unsupported"
];

/** The recorded owner decision a live policy must point at. See that file for what it does and does not authorize. */
export const LIVE_AUTHORIZATION_ADR = "docs/adr/0001-live-provisioning-authorization.md";

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

  // The policy names the transport it permits, and the engine must be holding exactly that transport.
  if (!["simulator", "live"].includes(policy.transport) || policy.transport !== transportKind) return "transport_unavailable";
  if (policy.transport === "live") {
    // Live mode needs the recorded owner decision, an acknowledgment that the adapters have not run against a real
    // system, and an exact host allowlist for every vendor in the plan. No wildcards, no defaults.
    const authorization = policy.liveAuthorization;
    if (authorization?.adr !== LIVE_AUTHORIZATION_ADR || authorization.acknowledgesUntested !== true) return "live_not_authorized";
    const hosts = policy.allowedHosts ?? {};
    if (Object.values(hosts).flat().some((host) => typeof host === "string" && host.includes("*"))) return "wildcard_not_permitted";
    for (const vendor of new Set(changeset.map((op) => op.vendor))) {
      const list = hosts[vendor];
      if (!Array.isArray(list) || list.length === 0 || !list.every((host) => typeof host === "string" && host.length > 0)) return "host_not_allowlisted";
    }
  }
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
