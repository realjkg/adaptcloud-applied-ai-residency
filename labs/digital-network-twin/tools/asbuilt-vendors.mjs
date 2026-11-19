// Vendor mappings: how each vendor's section of the twin config becomes vendor-neutral facts.
//
// A requirement names a fact such as `firewallRules` and, optionally, the vendors it applies to. Each mapping says
// whether its vendor is present in the config and which facts it can supply. A fact is a list of records. Every
// record carries `_path`, the exact place in the config it came from, so evidence can always be traced.
//
// To support another vendor, add an entry to VENDORS. Requirements do not change. A fact a vendor cannot supply is
// simply not evaluable for that vendor, which is a true statement and not a pass.

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const DAY = 24 * 60 * 60 * 1000;

/** "secret-reference" for a secret-store reference, "literal" for any other string, "unknown" if absent. Never returns the value. */
export function authenticationKind(ref) {
  if (typeof ref !== "string" || ref.length === 0) return "unknown";
  return ref.startsWith("secret-store://") ? "secret-reference" : "literal";
}

const lastRuleIsDenyAll = (rule) => Boolean(rule) && rule.action === "deny" && rule.source === "any" && rule.destination === "any" && rule.service === "any";

const paloalto = {
  present: (c) => isObject(c.paloalto),
  provides: {
    managementAccess: (c) => (isObject(c.management) ? [{ _path: "management", permittedSources: c.management.permittedSources, protocols: c.management.protocols }] : []),
    firewallRules: (c) => (Array.isArray(c.paloalto.rules) ? c.paloalto.rules.map((r, i) => ({ _path: `paloalto.rules[${i}]`, name: r.name, action: r.action, source: r.source, destination: r.destination, service: r.service, log: r.log, position: i + 1, fromZone: r.from, toZone: r.to })) : []),
    defaultDeny: (c) => {
      const rules = Array.isArray(c.paloalto.rules) ? c.paloalto.rules : [];
      return rules.length === 0 ? [] : [{ _path: "paloalto.rules", lastRuleAction: rules.at(-1).action, lastRuleIsDenyAll: lastRuleIsDenyAll(rules.at(-1)) }];
    },
    vpnTunnels: (c) => (isObject(c.paloalto.ipsec) ? [{ _path: "paloalto.ipsec", role: "hub", ikeVersion: c.paloalto.ipsec.ikeVersion, peer: c.paloalto.ipsec.peer, authentication: authenticationKind(c.paloalto.ipsec.pskRef) }] : [])
  }
};

const meraki = {
  present: (c) => isObject(c.meraki),
  provides: {
    // The Meraki model carries a protocol, a destination, and a port. It has no source and no logging flag, so a
    // requirement on those fields is unknown for Meraki rather than passed.
    firewallRules: (c) => (Array.isArray(c.meraki.firewall) ? c.meraki.firewall.map((r, i) => ({ _path: `meraki.firewall[${i}]`, action: r.policy, destination: r.destination, service: `${r.protocol}/${r.port}`, position: i + 1 })) : []),
    defaultDeny: (c) => {
      const rules = Array.isArray(c.meraki.firewall) ? c.meraki.firewall : [];
      const last = rules.at(-1);
      return rules.length === 0 ? [] : [{ _path: "meraki.firewall", lastRuleAction: last.policy, lastRuleIsDenyAll: last.policy === "deny" && last.protocol === "any" && last.destination === "any" && last.port === "any" }];
    },
    vpnTunnels: (c) => (isObject(c.meraki.nonMerakiPeer) ? [{ _path: "meraki.nonMerakiPeer", role: "spoke", ikeVersion: c.meraki.nonMerakiPeer.ikeVersion, peer: c.meraki.nonMerakiPeer.publicIp, authentication: authenticationKind(c.meraki.nonMerakiPeer.pskRef), remoteNetworks: c.meraki.nonMerakiPeer.remoteNetworks, localNetworks: c.meraki.nonMerakiPeer.localNetworks }] : [])
  }
};

const f5 = {
  present: (c) => isObject(c.f5),
  provides: {
    loadBalancing: (c) => (isObject(c.f5.pool) ? [{ _path: "f5.pool", pool: c.f5.pool.name, memberCount: Array.isArray(c.f5.pool.members) ? c.f5.pool.members.length : undefined, monitorType: c.f5.pool.monitor?.type, method: c.f5.pool.method }] : []),
    tlsEndpoints: (c) => (isObject(c.f5.clientSsl) ? [{ _path: "f5.clientSsl", role: "origin-termination", minVersion: c.f5.clientSsl.minVersion }] : []),
    certificates: (c) => {
      const cert = c.tls?.certificate;
      if (!isObject(cert)) return [];
      const end = Date.parse(cert.notAfter);
      const start = Date.parse(c.referenceDate);
      return [{ _path: "tls.certificate", subject: cert.subject, issuer: cert.issuer, notAfter: cert.notAfter, chainValidated: cert.chainValidated, daysRemaining: Number.isNaN(end) || Number.isNaN(start) ? undefined : Math.floor((end - start) / DAY) }];
    }
  }
};

const cloudflare = {
  present: (c) => isObject(c.cloudflare),
  provides: {
    edgeExposure: (c) => [{ _path: "cloudflare", proxied: c.cloudflare.dns?.proxied, wafAction: c.cloudflare.waf?.action, wafTuned: Boolean(c.cloudflare.waf?.tunedAt), originPulls: c.cloudflare.authenticatedOriginPulls }],
    // Cloudflare states the encryption mode but the model carries no minimum TLS version for the edge.
    tlsEndpoints: (c) => (isObject(c.cloudflare.ssl) ? [{ _path: "cloudflare.ssl", role: "edge", mode: c.cloudflare.ssl.mode, verifiesOrigin: c.cloudflare.ssl.mode === "strict" }] : [])
  }
};

export const VENDORS = { paloalto, meraki, f5, cloudflare };

/** The facts a vendor mapping can supply, for documentation and for coverage statements. */
export const factsOf = (vendors = VENDORS) => {
  const out = {};
  for (const [name, mapping] of Object.entries(vendors)) for (const fact of Object.keys(mapping.provides)) (out[fact] ??= []).push(name);
  return out;
};
