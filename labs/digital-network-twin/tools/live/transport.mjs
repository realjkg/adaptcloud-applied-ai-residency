// Live transport: routes each vendor to its adapter, each through its own guarded HTTP client whose only
// allowed hosts are that vendor's allowlisted hosts. Vendors without an adapter are refused as unsupported.
//
// Palo Alto Networks is not implemented. The REST API documentation read for this project (PAN-OS 11.1, see
// docs/API_NOTES.md) shows that address objects carry a description and that a rule can be moved, so this is a
// decision, not an impossibility. What stops it: a rule's service is a service object or application-default, and
// the REST API can create service objects but the change set does not define them yet, an ownership mark on rules
// and zones was not confirmed, and commit exists only in the XML API, which this layer leaves to a person.
//
// Cisco Meraki is not implemented. An L3 firewall rule has a comment that could carry a mark, but the PUT sends
// the whole ordered list and no concurrency guard is documented, so a write can overwrite a concurrent change.
// The third-party VPN peers call also sends the whole peer list, needs a plaintext secret per peer in the body,
// and the documentation warns that it skips the subnet-overlap validation the dashboard performs. Meraki also
// returns 404 for a bad API key and requires clients to follow redirects, both of which this layer would have to
// handle first (see docs/API_NOTES.md).
//
// NOT TESTED AGAINST A REAL SYSTEM. See docs/adr/0001-live-provisioning-authorization.md.

import { createCloudflareAdapter, UNSUPPORTED_REASON as CLOUDFLARE_NOTE } from "./cloudflare.mjs";
import { createF5Adapter, UNSUPPORTED_REASON as F5_NOTE } from "./f5.mjs";
import { createGuardedHttp } from "./guarded-http.mjs";

const NOTES = {
  paloalto: "not implemented: the change set defines no service objects, a mark on rules and zones is unconfirmed, and commit (XML API only) is left to a person",
  meraki: "not implemented: the whole rule or peer list is replaced in one call with no concurrency guard, a bad key returns 404, and redirects must be followed",
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
