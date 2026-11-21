// Roles and permissions. Deny by default: an action not listed for a role is refused. Roles come from the identity
// provider's group claim through an explicit mapping, never from anything the browser sends.

export const ROLES = ["viewer", "operator", "approver", "admin"];

const PERMISSIONS = {
  "snapshot:read": ["viewer", "operator", "approver", "admin"],
  "collect:run": ["operator", "admin"],
  "change:request": ["operator", "admin"],
  "change:read": ["viewer", "operator", "approver", "admin"],
  "change:approve": ["approver"],
  "change:apply": ["operator", "admin"],
  "operation:request": ["operator", "admin"],
  "operation:read": ["viewer", "operator", "approver", "admin"],
  "operation:approve": ["approver"],
  "operation:execute": ["operator", "admin"],
  "scenario:read": ["viewer", "operator", "approver", "admin"],
  "scenario:run": ["operator", "admin"],
  "task:read": ["viewer", "operator", "approver", "admin"],
  "task:run": ["operator", "admin"],
  "readiness:read": ["viewer", "operator", "approver", "admin"],
  "readiness:run": ["admin"],
  "schedule:manage": ["admin"],
  "snapshot:hold": ["admin"],
  "killswitch:set": ["admin"],
  "audit:read": ["approver", "admin"]
};

export const can = (roles, permission) => Array.isArray(roles) && (PERMISSIONS[permission] ?? []).some((r) => roles.includes(r));
export const permissionsFor = (roles) => Object.keys(PERMISSIONS).filter((p) => can(roles, p));

/** Maps provider groups to roles with an exact lookup. Unknown groups grant nothing. No group, no role, no access. */
export function rolesFromGroups(groups, mapping) {
  const out = new Set();
  for (const g of Array.isArray(groups) ? groups : []) {
    const role = typeof g === "string" && Object.hasOwn(mapping ?? {}, g) ? mapping[g] : undefined;
    if (ROLES.includes(role)) out.add(role);
  }
  return ROLES.filter((r) => out.has(r));
}
