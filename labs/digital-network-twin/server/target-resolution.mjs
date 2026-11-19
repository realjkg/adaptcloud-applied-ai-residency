// Target resolution. The browser supplies an alias; the server supplies everything else.
//
// Two registries: synthetic targets (fixtures) and live targets (from deployment settings). The execution mode comes from
// trusted deployment configuration, never from a request. An approval binds to the RESOLVED scope through a fingerprint,
// not just the alias, so repointing an alias invalidates every outstanding plan for it. The fingerprint is a binding check,
// not an approval and not a substitute for authorization: access is checked separately, at plan time and again at execution.
//
// Pure: no network, no clock, no environment. The learner deployment imports this module.

import { createHash, timingSafeEqual } from "node:crypto";
import { stableStringify } from "../tools/provision-policy.mjs";

export class TargetError extends Error {
  constructor(code) { super(code); this.name = "TargetError"; this.code = code; }
}

/** Flat settings or fixture input in, one structured, versioned target out. */
export function normalizeTarget(alias, t, mode) {
  const scope = t.vendor === "paloalto"
    ? { managementHost: t.scope?.managementHost ?? t.host ?? null, deviceGroup: t.scope?.deviceGroup ?? t.deviceGroup ?? null, firewallSerial: t.scope?.firewallSerial ?? t.firewallSerial ?? null, vsys: t.scope?.vsys ?? t.vsys ?? null }
    : t.vendor === "cloudflare"
    ? { accountId: t.scope?.accountId ?? t.accountId ?? null, zoneId: t.scope?.zoneId ?? t.zoneId ?? null, zoneName: t.scope?.zoneName ?? t.zoneName ?? null }
    : { organizationId: t.scope?.organizationId ?? t.organizationId ?? null, networkId: t.scope?.networkId ?? t.networkId ?? null, applianceSerial: t.scope?.applianceSerial ?? t.applianceSerial ?? null };
  return { ...t, id: alias, mode: t.mode ?? mode, scope, capabilities: new Set(t.capabilities ?? t.changeTypes ?? []) };
}

const scopeKey = (t) => stableStringify(t.scope);

export function targetFingerprint(alias, capability, target) {
  return createHash("sha256").update(stableStringify({ version: 1, alias, mode: target.mode, vendor: target.vendor, capability, scope: target.scope })).digest("hex");
}

const placeholderHost = (host) => { const h = String(host ?? "").replace(/\.$/, "").toLowerCase(); return h === "example" || h.endsWith(".example") || h === "localhost"; };

const placeholderZone = (name) => { const z = String(name ?? "").toLowerCase(); return z === "" || /(^|\.)(example|test|invalid|localhost)$/.test(z) || /(^|\.)example\.(com|net|org)$/.test(z); };

/**
 * @param {object} options
 * @param {"simulator"|"live"} options.mode from deployment configuration
 * @param {Map<string, object>} options.targets the registry for this mode
 * @param {Map<string, object>} [options.fixtures] the synthetic registry, used to keep fixtures out of a live inventory
 */
export function createTargetResolver({ mode, targets, fixtures = new Map() }) {
  if (mode !== "simulator" && mode !== "live") throw new TargetError("INVALID_EXECUTION_MODE");
  const registry = new Map();
  for (const [alias, raw] of targets instanceof Map ? targets : Object.entries(targets ?? {})) registry.set(alias, normalizeTarget(alias, raw, mode));

  if (mode === "live") {
    // No fallback from the live inventory to simulator fixtures.
    const fixtureAliases = new Set(fixtures.keys());
    const fixtureScopes = new Set([...fixtures.entries()].map(([a, t]) => scopeKey(normalizeTarget(a, t, "simulator"))));
    const fixtureNetworks = new Set([...fixtures.entries()].map(([a, t]) => normalizeTarget(a, t, "simulator").scope.networkId).filter(Boolean));
    for (const [alias, t] of registry) {
      if (fixtureAliases.has(alias)) throw new TargetError("LIVE_INVENTORY_USES_RESERVED_FIXTURE_ALIAS");
      if (t.mode !== "live" || fixtureScopes.has(scopeKey(t))) throw new TargetError("FIXTURE_IN_LIVE_INVENTORY");
      if (t.vendor === "paloalto" && placeholderHost(t.scope.managementHost)) throw new TargetError("PLACEHOLDER_HOST_IN_LIVE_INVENTORY");
      if (t.vendor === "cloudflare" && placeholderZone(t.scope.zoneName)) throw new TargetError("PLACEHOLDER_ZONE_IN_LIVE_INVENTORY");
      if (t.vendor === "meraki" && fixtureNetworks.has(t.scope.networkId)) throw new TargetError("FIXTURE_NETWORK_IN_LIVE_INVENTORY");
    }
  } else {
    for (const t of registry.values()) if (t.mode !== "simulator") throw new TargetError("LIVE_TARGET_IN_SIMULATOR_REGISTRY");
  }

  return {
    mode,
    // One error for every reason, so a caller cannot probe which aliases or capabilities exist.
    resolve(alias, capability) {
      const t = typeof alias === "string" ? registry.get(alias) : undefined;
      if (!t || t.mode !== mode || !t.capabilities.has(capability)) throw new TargetError("TARGET_NOT_AVAILABLE");
      return t;
    },
    aliases: () => [...registry.keys()],
    /** Server-side only: the normalized target without a capability check, for building listings. */
    inspect: (alias) => registry.get(alias) ?? null
  };
}

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/** Re-resolves the approved alias and capability and compares the fingerprint, before any vendor client exists. */
export function resolveForExecution(resolver, { alias, capability, fingerprint }) {
  const target = resolver.resolve(alias, capability);
  if (!same(targetFingerprint(alias, capability, target), fingerprint)) throw new TargetError("APPROVED_TARGET_CHANGED");
  return target;
}

/**
 * Access policy: allows({ principalId, contextId, alias, capability, target }) -> boolean.
 * Deny by default. Resolves the alias and authorizes it before a plan is stored.
 */
export function bindTarget(resolver, policy, { principalId, contextId, alias, capability }) {
  const target = resolver.resolve(alias, capability);
  if (!policy.allows({ principalId, contextId, alias, capability, target })) throw new TargetError("TARGET_NOT_AVAILABLE");
  return { target, binding: { alias, capability, fingerprint: targetFingerprint(alias, capability, target) } };
}

/** Rechecks current scope and access immediately before a vendor client is built. */
export function recheckBoundTarget(resolver, policy, { principalId, contextId, binding }) {
  const target = resolveForExecution(resolver, binding);
  if (!policy.allows({ principalId, contextId, alias: binding.alias, capability: binding.capability, target })) throw new TargetError("TARGET_NOT_AVAILABLE");
  return target;
}

export const denyAllPolicy = { allows: () => false };

/** Learner labs: a lab has members and the aliases it may use. A principal outside the lab gets nothing. */
export function createLabPolicy(labs) {
  return {
    /** Is this principal enrolled in this lab? Used for records that are not tied to one device. */
    member: ({ principalId, contextId }) => typeof contextId === "string" && Object.hasOwn(labs, contextId) && labs[contextId].members.includes(principalId),
    allows: ({ principalId, contextId, alias, target }) => {
    const lab = Object.hasOwn(labs, contextId) ? labs[contextId] : null;
    return lab !== null && target.mode === "simulator" && lab.members.includes(principalId) && lab.aliases.includes(alias);
    }
  };
}

/** Live targets: only principals the deployment lists for that alias, and only in the live context. */
export function createLivePolicy(access) {
  return {
    member: ({ contextId }) => contextId === "live",
    allows: ({ principalId, contextId, alias, target }) => contextId === "live" && target.mode === "live" && Array.isArray(access[alias]) && access[alias].includes(principalId)
  };
}
