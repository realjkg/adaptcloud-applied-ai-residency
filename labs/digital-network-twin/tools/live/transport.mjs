// Live transport: routes each vendor to its adapter, each through its own guarded HTTP client whose only
// allowed hosts are that vendor's allowlisted hosts. Vendors without an adapter are refused as unsupported.
//
// Palo Alto Networks is not implemented. A security rule needs service objects the change set does not define,
// zones and address objects that cannot carry an ownership mark, and a commit that this layer deliberately
// leaves to a person. Guessing at those on a real firewall is not safe.
//
// Cisco Meraki is not implemented. Its non-Meraki VPN peers and its L3 firewall rules are replaced as whole
// lists, so one write can remove entries this twin does not own, and there is no per-entry ownership mark.
//
// NOT TESTED AGAINST A REAL SYSTEM. See docs/adr/0001-live-provisioning-authorization.md.

import { createCloudflareAdapter, UNSUPPORTED_REASON as CLOUDFLARE_NOTE } from "./cloudflare.mjs";
import { createF5Adapter, UNSUPPORTED_REASON as F5_NOTE } from "./f5.mjs";
import { createGuardedHttp } from "./guarded-http.mjs";

const NOTES = {
  paloalto: "not implemented: rules need service objects, zones cannot carry an ownership mark, and commit is left to a person",
  meraki: "not implemented: VPN peers and firewall rules are replaced as whole lists with no per-entry ownership mark",
  cloudflare: CLOUDFLARE_NOTE,
  f5: F5_NOTE
};

/**
 * @param {object} options
 * @param {object} options.policy must carry allowedHosts per vendor, and live settings: { cloudflare: { zoneId }, f5: { host } }
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createLiveTransport({ policy, env = process.env, fetchImpl = globalThis.fetch }) {
  const settings = policy.live ?? {};
  const hostsFor = (vendor) => (Array.isArray(policy.allowedHosts?.[vendor]) ? policy.allowedHosts[vendor] : []);
  const adapters = {};
  if (settings.cloudflare?.zoneId) {
    adapters.cloudflare = createCloudflareAdapter({ http: createGuardedHttp({ allowedHosts: hostsFor("cloudflare"), fetchImpl }), zoneId: settings.cloudflare.zoneId, env });
  }
  if (settings.f5?.host) {
    adapters.f5 = createF5Adapter({ http: createGuardedHttp({ allowedHosts: hostsFor("f5"), fetchImpl }), host: settings.f5.host, env });
  }
  const adapter = (vendor) => {
    const found = adapters[vendor];
    if (!found) throw new Error(`no adapter for ${vendor}`);
    return found;
  };

  return {
    kind: "live",
    supports: (op) => adapters[op.vendor]?.supports(op) === true,
    unsupportedReason: (op) => (adapters[op.vendor] ? NOTES[op.vendor] : NOTES[op.vendor] ?? "no adapter"),
    read: (key, ctx) => adapter(key.vendor).read(key, ctx),
    create: (key, attributes, owner) => adapter(key.vendor).create(key, attributes, owner),
    delete: (key, owner, ctx) => adapter(key.vendor).delete(key, owner, ctx)
  };
}
