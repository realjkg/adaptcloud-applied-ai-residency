// Deterministic health checks for the twin configuration.
// Each check returns null when healthy or a short message when not. Messages name fields,
// never values, so a pasted secret cannot reappear in output.

const LAB_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"];
const SECRET_KEY = /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|^psk$/i;
const PRIVATE_KEY_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const TLS_OK = ["TLSv1.2", "TLSv1.3"];
const DAY = 24 * 60 * 60 * 1000;

function toInt(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

function parseCidr(text) {
  const [address, length] = String(text).split("/");
  const base = toInt(address);
  const bits = length === undefined ? 32 : Number(length);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { base, bits };
}

/** True when `inner` (address or CIDR) sits inside `outer`. A wider range is never inside a narrower one. */
export function within(inner, outer) {
  const a = parseCidr(inner);
  const b = parseCidr(outer);
  if (!a || !b || a.bits < b.bits) return false;
  const size = 2 ** (32 - b.bits);
  return Math.floor(a.base / size) === Math.floor(b.base / size);
}

export const isLabAddress = (value) => LAB_RANGES.some((range) => within(value, range));

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const rule = (config, name) => (config.paloalto?.rules ?? []).find((candidate) => candidate.name === name);
const iface = (config, name) => (config.paloalto?.interfaces ?? []).find((candidate) => candidate.name === name);

function walk(value, path, visit) {
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
  else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      visit(key, child, childPath);
      walk(child, childPath, visit);
    }
  }
}

const PLAN_KEYS = ["origin", "originGateway", "dmzSubnet", "f5Self", "vip", "appSubnet", "branchWan", "branchLan", "mgmtSubnet", "panorama"];

export const CHECKS = [
  {
    id: "HC-00-SECRET", stage: "00",
    title: "No credential-like field or private key material anywhere in the config",
    run(config) {
      const hits = [];
      walk(config, "", (key, value, path) => {
        if (SECRET_KEY.test(key)) hits.push(path);
        else if (typeof value === "string" && PRIVATE_KEY_VALUE.test(value)) hits.push(path);
      });
      return hits.length ? `secret material at: ${hits.join(", ")}` : null;
    }
  },
  {
    id: "HC-01-PLAN", stage: "01",
    title: "Addressing plan names every required address and the application hostname",
    run(config) {
      const missing = PLAN_KEYS.filter((key) => typeof config.addressing?.[key] !== "string");
      if (typeof config.hostname !== "string" || !config.hostname) missing.push("hostname");
      return missing.length ? `missing: ${missing.join(", ")}` : null;
    }
  },
  {
    id: "HC-01-ADDR", stage: "01",
    title: "Every planned address is in an RFC 5737 or RFC 1918 range",
    run(config) {
      const bad = Object.entries(config.addressing ?? {}).filter(([, value]) => !isLabAddress(value)).map(([key]) => key);
      return bad.length ? `outside lab ranges: ${bad.join(", ")}` : null;
    }
  },
  {
    id: "HC-01-UNIQUE", stage: "01",
    title: "No host address is planned twice",
    run(config) {
      const hosts = Object.entries(config.addressing ?? {}).filter(([, value]) => !String(value).includes("/"));
      const seen = new Map();
      const dupes = [];
      for (const [key, value] of hosts) {
        if (seen.has(value)) dupes.push(`${seen.get(value)}/${key}`);
        else seen.set(value, key);
      }
      return dupes.length ? `duplicate address: ${dupes.join(", ")}` : null;
    }
  },
  {
    id: "HC-02-MGT-SOURCE", stage: "02",
    title: "Management permitted sources are a specific network inside the management subnet",
    run(config) {
      const sources = config.management?.permittedSources;
      if (!Array.isArray(sources) || sources.length === 0) return "permittedSources is empty, which allows any source";
      const bad = sources.filter((source) => !within(source, config.addressing?.mgmtSubnet));
      return bad.length ? `${bad.length} permitted source(s) outside the management subnet` : null;
    }
  },
  {
    id: "HC-02-MGT-PROTO", stage: "02",
    title: "Management uses HTTPS and SSH only",
    run(config) {
      const protocols = config.management?.protocols;
      if (!Array.isArray(protocols) || protocols.length === 0) return "no management protocols declared";
      const bad = protocols.filter((protocol) => !["https", "ssh"].includes(protocol));
      return bad.length ? `disallowed management protocol(s): ${bad.join(", ")}` : null;
    }
  },
  {
    id: "HC-02-PROFILE", stage: "02",
    title: "Interface management profiles exist only in the management zone and are restricted",
    run(config) {
      for (const item of config.paloalto?.interfaces ?? []) {
        const profile = item.managementProfile;
        if (profile === undefined) continue;
        if (item.zone !== "management") return `${item.name} carries a management profile outside the management zone`;
        if (!Array.isArray(profile.services) || profile.services.some((service) => !["https", "ssh"].includes(service))) return `${item.name} enables a disallowed management service`;
        if (!Array.isArray(profile.permittedSources) || profile.permittedSources.length === 0) return `${item.name} has no permitted sources`;
        if (profile.permittedSources.some((source) => !within(source, config.addressing?.mgmtSubnet))) return `${item.name} permits a source outside the management subnet`;
      }
      return null;
    }
  },
  {
    id: "HC-03-ZONES", stage: "03",
    title: "Required zones are declared",
    run(config) {
      const zones = config.paloalto?.zones ?? [];
      const missing = ["untrust", "dmz", "app", "management"].filter((zone) => !zones.includes(zone));
      return missing.length ? `missing zones: ${missing.join(", ")}` : null;
    }
  },
  {
    id: "HC-03-IFACE", stage: "03",
    title: "Interfaces are unique, zoned, and addressed from the plan",
    run(config) {
      const interfaces = config.paloalto?.interfaces ?? [];
      if (interfaces.length === 0) return "no interfaces declared";
      const names = interfaces.map((item) => item.name);
      if (new Set(names).size !== names.length) return "duplicate interface name";
      const zones = config.paloalto?.zones ?? [];
      const plan = config.addressing ?? {};
      for (const item of interfaces) {
        if (!zones.includes(item.zone)) return `${item.name} uses an undeclared zone`;
        if (!isLabAddress(item.address)) return `${item.name} address is outside lab ranges`;
        if (item.zone === "untrust" && String(item.address).split("/")[0] !== plan.origin) return `${item.name} does not carry the planned origin address`;
        if (item.zone === "dmz" && !within(item.address, plan.dmzSubnet)) return `${item.name} is outside the DMZ subnet`;
        if (item.zone === "app" && !within(item.address, plan.appSubnet)) return `${item.name} is outside the app subnet`;
        if (item.zone === "management" && !within(item.address, plan.mgmtSubnet)) return `${item.name} is outside the management subnet`;
      }
      return null;
    }
  },
  {
    id: "HC-03-ROUTES", stage: "03",
    title: "A default route and an app-subnet route exist",
    run(config) {
      const routes = config.paloalto?.routes ?? [];
      const def = routes.find((route) => route.destination === "0.0.0.0/0");
      if (!def || def.nextHop !== config.addressing?.originGateway) return "default route missing or not via the origin gateway";
      if (!routes.some((route) => route.destination === config.addressing?.appSubnet)) return "no route for the app subnet";
      return null;
    }
  },
  {
    id: "HC-04-MEMBERS", stage: "04",
    title: "Pool has at least two unique members inside the app subnet",
    run(config) {
      const members = config.f5?.pool?.members;
      if (!Array.isArray(members) || members.length < 2) return "pool needs at least two members";
      if (new Set(members.map((member) => member.address)).size !== members.length) return "duplicate pool member";
      for (const member of members) {
        if (!within(member.address, config.addressing?.appSubnet)) return "a pool member is outside the app subnet";
        if (!Number.isInteger(member.port) || member.port < 1 || member.port > 65535) return "a pool member has an invalid port";
      }
      return null;
    }
  },
  {
    id: "HC-04-MONITOR", stage: "04",
    title: "Health monitor is HTTP(S) with a CRLF-terminated send string and an expected response",
    run(config) {
      const monitor = config.f5?.pool?.monitor;
      if (!monitor) return "pool has no health monitor";
      if (!["http", "https"].includes(monitor.type)) return "monitor type must be http or https";
      if (typeof monitor.send !== "string" || !monitor.send.endsWith("\r\n")) return "monitor send string must end with a carriage return and line feed";
      if (typeof monitor.receive !== "string" || !monitor.receive) return "monitor has no expected response";
      return null;
    }
  },
  {
    id: "HC-05-CERT-NAME", stage: "05",
    title: "Certificate subject matches the application hostname",
    run(config) {
      return config.tls?.certificate?.subject === config.hostname ? null : "certificate subject does not match the hostname";
    }
  },
  {
    id: "HC-05-CERT-EXPIRY", stage: "05",
    title: "Certificate is valid for at least 30 more days",
    run(config) {
      const end = Date.parse(config.tls?.certificate?.notAfter);
      const start = Date.parse(config.referenceDate);
      if (Number.isNaN(end) || Number.isNaN(start)) return "certificate or reference date is not a valid date";
      return end - start >= 30 * DAY ? null : "certificate expires within 30 days or is already expired";
    }
  },
  {
    id: "HC-05-CERT-CHAIN", stage: "05",
    title: "Certificate chain validates and is acceptable to Cloudflare Full (strict)",
    run(config) {
      const certificate = config.tls?.certificate;
      if (certificate?.chainValidated !== true) return "chain is not validated";
      return ["public-ca", "cloudflare-origin-ca"].includes(certificate.issuer) ? null : "issuer is not a publicly trusted CA or Cloudflare Origin CA";
    }
  },
  {
    id: "HC-06-VIP", stage: "06",
    title: "Virtual server listens on the planned VIP and port 443",
    run(config) {
      return config.f5?.virtualServer?.destination === `${config.addressing?.vip}:443` ? null : "virtual server destination is not the planned VIP on 443";
    }
  },
  {
    id: "HC-06-POOL", stage: "06",
    title: "Virtual server uses the declared pool",
    run(config) {
      const pool = config.f5?.pool?.name;
      return pool && config.f5?.virtualServer?.pool === pool ? null : "virtual server does not reference the declared pool";
    }
  },
  {
    id: "HC-06-TLS", stage: "06",
    title: "Client SSL profile uses TLS 1.2 or later and the declared certificate",
    run(config) {
      const profile = config.f5?.clientSsl;
      if (!profile || !TLS_OK.includes(profile.minVersion)) return "client SSL minimum version must be TLS 1.2 or later";
      if (profile.certificate !== config.tls?.certificate?.name) return "client SSL profile does not reference the declared certificate";
      return config.f5?.virtualServer?.clientSslProfile === profile.name ? null : "virtual server does not use the client SSL profile";
    }
  },
  {
    id: "HC-06-SNAT", stage: "06",
    title: "SNAT automap keeps return traffic on the BIG-IP",
    run(config) {
      return config.f5?.virtualServer?.snat === "automap" ? null : "snat is not automap";
    }
  },
  {
    id: "HC-07-ORDER", stage: "07",
    title: "Default deny is the last rule",
    run(config) {
      const rules = config.paloalto?.rules ?? [];
      const isDeny = (item) => item.action === "deny" && item.source === "any" && item.destination === "any" && item.service === "any";
      if (rules.length === 0 || !isDeny(rules.at(-1))) return "the last rule is not a deny-all rule";
      return rules.slice(0, -1).some(isDeny) ? "a deny-all rule sits above other rules" : null;
    }
  },
  {
    id: "HC-07-NARROW", stage: "07",
    title: "No allow rule uses any for zone, address, or service",
    run(config) {
      const broad = (config.paloalto?.rules ?? []).filter((item) => item.action === "allow" && [item.from, item.to, item.source, item.destination, item.service].includes("any"));
      return broad.length ? `broad allow rule(s): ${broad.map((item) => item.name).join(", ")}` : null;
    }
  },
  {
    id: "HC-07-EDGE", stage: "07",
    title: "Edge rule admits only the Cloudflare ranges to the pre-NAT origin on 443",
    run(config) {
      const edge = rule(config, "edge-https");
      if (!edge) return "edge-https rule is missing";
      const object = config.paloalto?.addressObjects?.["cloudflare-ranges"];
      if (edge.source !== "cloudflare-ranges" || object?.source !== "published-list") return "edge rule source is not the published Cloudflare list object";
      if (edge.destination !== config.addressing?.origin) return "edge rule destination is not the pre-NAT origin address";
      if (edge.from !== "untrust" || edge.to !== "dmz") return "edge rule must go from untrust to the post-NAT zone dmz";
      return edge.service === "tcp/443" && edge.action === "allow" ? null : "edge rule must allow tcp/443";
    }
  },
  {
    id: "HC-07-FRESH", stage: "07",
    title: "Cloudflare range list was refreshed within 30 days",
    run(config) {
      const refreshed = Date.parse(config.paloalto?.addressObjects?.["cloudflare-ranges"]?.refreshed);
      const now = Date.parse(config.referenceDate);
      if (Number.isNaN(refreshed) || Number.isNaN(now)) return "range list refresh date is missing";
      return now - refreshed <= 30 * DAY ? null : "range list is older than 30 days";
    }
  },
  {
    id: "HC-07-NAT", stage: "07",
    title: "Destination NAT maps the origin on 443 to the VIP on 443",
    run(config) {
      const ok = (config.paloalto?.nat ?? []).some((nat) => nat.original === `${config.addressing?.origin}:443` && nat.translated === `${config.addressing?.vip}:443`);
      return ok ? null : "no NAT rule from the origin to the VIP";
    }
  },
  {
    id: "HC-07-BRANCH", stage: "07",
    title: "Branch rule admits only the branch LAN to the VIP on 443",
    run(config) {
      const branch = rule(config, "branch-https");
      if (!branch) return "branch-https rule is missing";
      const ok = branch.from === "vpn-branch" && branch.to === "dmz" && branch.source === config.addressing?.branchLan && branch.destination === config.addressing?.vip && branch.service === "tcp/443" && branch.action === "allow";
      return ok ? null : "branch rule does not match the branch LAN, VIP, and tcp/443";
    }
  },
  {
    id: "HC-07-POOLPATH", stage: "07",
    title: "Only the F5 self-IP may reach the pool, on the pool port",
    run(config) {
      const pool = rule(config, "f5-to-pool");
      if (!pool) return "f5-to-pool rule is missing";
      const port = config.f5?.pool?.members?.[0]?.port;
      const ok = pool.from === "dmz" && pool.to === "app" && pool.source === config.addressing?.f5Self && pool.destination === config.addressing?.appSubnet && pool.service === `tcp/${port}` && pool.action === "allow";
      return ok ? null : "pool rule does not match the F5 self-IP, app subnet, and pool port";
    }
  },
  {
    id: "HC-07-LOG", stage: "07",
    title: "Every rule logs",
    run(config) {
      const quiet = (config.paloalto?.rules ?? []).filter((item) => item.log !== true).map((item) => item.name);
      return quiet.length ? `rule(s) without logging: ${quiet.join(", ")}` : null;
    }
  },
  {
    id: "HC-08-PROXIED", stage: "08",
    title: "DNS record is proxied and points at the origin",
    run(config) {
      const dns = config.cloudflare?.dns;
      if (dns?.proxied !== true) return "DNS record is not proxied";
      return dns.content === config.addressing?.origin && dns.name === config.hostname ? null : "DNS record does not map the hostname to the origin";
    }
  },
  {
    id: "HC-08-SSLMODE", stage: "08",
    title: "SSL/TLS mode is Full (strict)",
    run(config) {
      return config.cloudflare?.ssl?.mode === "strict" ? null : "SSL/TLS mode is not strict";
    }
  },
  {
    id: "HC-09-WAF", stage: "09",
    title: "Managed WAF is on, and block mode follows tuning",
    run(config) {
      const waf = config.cloudflare?.waf;
      if (waf?.managedRuleset !== true) return "managed ruleset is not enabled";
      if (!["log", "block"].includes(waf.action)) return "WAF action must be log or block";
      return waf.action === "block" && !waf.tunedAt ? "block mode without a recorded tuning period" : null;
    }
  },
  {
    id: "HC-09-ORIGIN", stage: "09",
    title: "Origin accepts only Cloudflare: Authenticated Origin Pulls and a source-restricted edge rule",
    run(config) {
      if (config.cloudflare?.authenticatedOriginPulls !== true) return "Authenticated Origin Pulls is off";
      return rule(config, "edge-https")?.source === "cloudflare-ranges" ? null : "edge rule is not restricted to the Cloudflare ranges";
    }
  },
  {
    id: "HC-10-IKE", stage: "10",
    title: "Both ends use IKEv2",
    run(config) {
      return config.paloalto?.ipsec?.ikeVersion === 2 && config.meraki?.nonMerakiPeer?.ikeVersion === 2 ? null : "IKE version is not 2 on both ends";
    }
  },
  {
    id: "HC-10-PEERS", stage: "10",
    title: "Each end points at the other's public address",
    run(config) {
      if (config.paloalto?.ipsec?.peer !== config.addressing?.branchWan) return "NGFW peer is not the branch WAN address";
      return config.meraki?.nonMerakiPeer?.publicIp === config.addressing?.origin ? null : "MX peer is not the NGFW origin address";
    }
  },
  {
    id: "HC-10-PSK", stage: "10",
    title: "Pre-shared key is a matching secret-store reference, not a literal",
    run(config) {
      const a = config.paloalto?.ipsec?.pskRef;
      const b = config.meraki?.nonMerakiPeer?.pskRef;
      if (![a, b].every((ref) => typeof ref === "string" && ref.startsWith("secret-store://"))) return "pskRef is missing or not a secret-store reference";
      return a === b ? null : "the two ends reference different keys";
    }
  },
  {
    id: "HC-10-NETS", stage: "10",
    title: "Tunnel carries the branch LAN and the VIP only",
    run(config) {
      const peer = config.meraki?.nonMerakiPeer;
      if (!peer?.localNetworks?.includes(config.addressing?.branchLan)) return "branch LAN is not a local network";
      const remote = peer.remoteNetworks ?? [];
      if (!remote.includes(`${config.addressing?.vip}/32`)) return "the VIP is not a remote network";
      if (remote.some((network) => network === "0.0.0.0/0" || !isLabAddress(network))) return "a remote network is a default route or outside lab ranges";
      return remote.some((network) => within(network, config.addressing?.appSubnet) || within(config.addressing?.appSubnet, network)) ? "a remote network exposes the app subnet" : null;
    }
  },
  {
    id: "HC-10-ZONE", stage: "10",
    title: "Tunnel interface is in the vpn-branch zone",
    run(config) {
      const tunnel = iface(config, config.paloalto?.ipsec?.tunnelInterface);
      return tunnel?.zone === "vpn-branch" ? null : "tunnel interface is missing or not in vpn-branch";
    }
  },
  {
    id: "HC-11-FW", stage: "11",
    title: "Branch firewall allows tcp/443 to the VIP only and denies other data center traffic",
    run(config) {
      const fw = config.meraki?.firewall ?? [];
      const allows = fw.filter((item) => item.policy === "allow");
      const first = fw[0];
      if (allows.length !== 1) return "branch firewall must have exactly one allow rule";
      if (!(first.policy === "allow" && first.protocol === "tcp" && first.port === "443" && first.destination === `${config.addressing?.vip}/32`)) return "the allow rule is not tcp/443 to the VIP first";
      return fw.slice(1).some((item) => item.policy === "deny" && within(config.addressing?.vip, item.destination)) ? null : "no deny rule covers the data center networks";
    }
  },
  {
    id: "HC-11-RETURN", stage: "11",
    title: "NGFW routes the branch LAN back through the tunnel",
    run(config) {
      const ok = (config.paloalto?.routes ?? []).some((route) => route.destination === config.addressing?.branchLan && route.nextHop === config.paloalto?.ipsec?.tunnelInterface);
      return ok ? null : "no return route for the branch LAN via the tunnel";
    }
  },
  {
    id: "HC-11-ISOLATION", stage: "11",
    title: "Only the dmz zone may reach the app zone, so the F5 is the sole path to the pool",
    run(config) {
      const leaks = (config.paloalto?.rules ?? []).filter((item) => item.action === "allow" && item.to === "app" && item.from !== "dmz");
      return leaks.length ? `rule(s) reach the app zone from outside dmz: ${leaks.map((item) => item.name).join(", ")}` : null;
    }
  },
  {
    id: "HC-12-RESULTS", stage: "12",
    title: "All seven validation checks are recorded as pass",
    run(config) {
      const required = ["public-path", "origin-lock", "branch-path", "pool-isolation", "management-isolation", "default-deny", "failure-drill"];
      const results = config.validation?.results ?? [];
      const missing = required.filter((id) => !results.some((entry) => entry.id === id && entry.result === "pass"));
      return missing.length ? `not passing: ${missing.join(", ")}` : null;
    }
  },
  {
    id: "HC-12-NOFAIL", stage: "12",
    title: "No validation result is anything other than pass",
    run(config) {
      const odd = (config.validation?.results ?? []).filter((entry) => entry.result !== "pass");
      return odd.length ? `${odd.length} result(s) are not pass` : null;
    }
  },
  {
    id: "HC-12-ENFORCED", stage: "12",
    title: "WAF is enforcing, not logging only",
    run(config) {
      return config.cloudflare?.waf?.action === "block" ? null : "WAF is not in block mode";
    }
  }
];

/** Runs one check, turning any unexpected shape into a failure rather than a crash. */
export function runCheck(check, config) {
  try {
    const message = check.run(config);
    return { id: check.id, stage: check.stage, title: check.title, ok: message === null, message };
  } catch {
    return { id: check.id, stage: check.stage, title: check.title, ok: false, message: "the section this check reads is missing or malformed" };
  }
}

/** Global checks run at every stage, followed by the checks owned by that stage. */
export function checksForStage(stageId) {
  return CHECKS.filter((check) => check.stage === "00" || check.stage === stageId);
}

export function runStageChecks(stageId, config) {
  return checksForStage(stageId).map((check) => runCheck(check, config));
}
