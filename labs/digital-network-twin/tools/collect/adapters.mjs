// Read-only collectors. Each reads one vendor through a guarded GET-only client and returns the part of the twin
// config it can observe, in the same shape the twin config uses, so the topology builder draws observed and intended
// state the same way.
//
// NOT TESTED AGAINST A REAL SYSTEM. Response shapes follow docs/API_NOTES.md and are checked here only against fakes.
// A response that does not have the expected shape is an error for that vendor, never a guess.

import { secretFromEnv } from "../live/credentials.mjs";

const bad = (vendor, what) => { throw new Error(`${vendor}: unexpected ${what}`); };
const list = (v) => (Array.isArray(v) ? v : []);
const members = (v) => list(v?.member).filter((m) => typeof m === "string");
const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);

export const COLLECTORS = {
  cloudflare: {
    level: "account API token with read permissions on the zone",
    async collect({ http, settings, env }) {
      const auth = () => ({ authorization: `Bearer ${secretFromEnv(env, "CLOUDFLARE_API_TOKEN").reveal()}` });
      const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(settings.zoneId)}`;
      const dns = await http({ method: "GET", url: `${base}/dns_records?name.exact=${encodeURIComponent(settings.recordName)}`, auth });
      if (dns.status !== 200 || !Array.isArray(dns.json?.result)) bad("cloudflare", "dns response");
      const ssl = await http({ method: "GET", url: `${base}/settings/ssl`, auth });
      if (ssl.status !== 200 || typeof ssl.json?.result?.value !== "string") bad("cloudflare", "ssl response");
      const rec = dns.json.result[0];
      return { cloudflare: { ...(rec ? { dns: { name: str(rec.name), type: str(rec.type), content: str(rec.content), proxied: rec.proxied === true } } : {}), ssl: { mode: ssl.json.result.value } } };
    }
  },
  f5: {
    level: "BIG-IP user with a read-only role",
    async collect({ http, settings, env }) {
      const auth = () => ({ authorization: `Basic ${Buffer.from(`${secretFromEnv(env, "BIGIP_USERNAME").reveal()}:${secretFromEnv(env, "BIGIP_PASSWORD").reveal()}`).toString("base64")}` });
      const root = `https://${settings.host}/mgmt/tm/ltm`;
      const vs = await http({ method: "GET", url: `${root}/virtual`, auth });
      if (vs.status !== 200 || !Array.isArray(vs.json?.items)) bad("f5", "virtual response");
      const pools = await http({ method: "GET", url: `${root}/pool?expandSubcollections=true`, auth });
      if (pools.status !== 200 || !Array.isArray(pools.json?.items)) bad("f5", "pool response");
      const strip = (v) => str(v).replace(/^\/Common\//, "");
      const v = vs.json.items.find((i) => i.name === settings.virtualServer) ?? vs.json.items[0];
      const p = v ? pools.json.items.find((i) => i.name === strip(v.pool)) : undefined;
      const out = {};
      if (p) out.pool = { name: str(p.name), method: str(p.loadBalancingMode, "round-robin"), members: list(p.membersReference?.items).map((m) => ({ address: str(m.address), port: Number(String(m.name).split(":").pop()) || 0 })), monitor: { type: "http", send: "", receive: "" } };
      if (v) out.virtualServer = { name: str(v.name), destination: strip(v.destination).replace(/:.*$/, (m) => m), protocol: str(v.ipProtocol, "tcp"), pool: strip(v.pool), clientSslProfile: "", snat: str(v.sourceAddressTranslation?.type, "none") };
      return { f5: out };
    }
  },
  paloalto: {
    level: "firewall or Panorama administrator with a read-only role",
    async collect({ http, settings, env }) {
      const auth = () => ({ "x-pan-key": secretFromEnv(env, "PANOS_API_KEY").reveal() });
      const root = `https://${settings.host}/restapi/v11.0`;
      const q = `location=vsys&vsys=${encodeURIComponent(settings.vsys ?? "vsys1")}`;
      const get = async (path) => {
        const r = await http({ method: "GET", url: `${root}/${path}?${q}`, auth });
        if (r.status !== 200 || !Array.isArray(r.json?.result?.entry ?? [])) bad("paloalto", `${path} response`);
        return list(r.json?.result?.entry);
      };
      const zones = await get("Network/Zones");
      const rules = await get("Policies/SecurityRules");
      const nat = await get("Policies/NatRules");
      return { paloalto: {
        zones: zones.map((z) => str(z["@name"])).filter(Boolean),
        rules: rules.map((r) => ({ name: str(r["@name"]), from: members(r.from)[0] ?? "any", to: members(r.to)[0] ?? "any", source: members(r.source)[0] ?? "any", destination: members(r.destination)[0] ?? "any", service: members(r.service)[0] ?? "any", action: str(r.action, "deny"), log: r["log-end"] !== "no", profile: "" })),
        nat: nat.map((n) => ({ name: str(n["@name"]), from: members(n.from)[0] ?? "any", original: members(n.destination)[0] ?? "any", translated: str(n["destination-translation"]?.["translated-address"]) }))
      } };
    }
  },
  meraki: {
    level: "organization read-only administrator, as a dedicated lab-only account",
    async collect({ http, settings, env }) {
      const auth = () => ({ authorization: `Bearer ${secretFromEnv(env, "MERAKI_API_KEY").reveal()}` });
      const root = `https://${settings.host ?? "api.meraki.com"}/api/v1`;
      const rules = await http({ method: "GET", url: `${root}/networks/${encodeURIComponent(settings.networkId)}/appliance/firewall/l3FirewallRules`, auth });
      if (rules.status !== 200 || !Array.isArray(rules.json?.rules)) bad("meraki", "firewall response");
      return { meraki: { firewall: rules.json.rules.filter((r) => r.comment !== "Default rule").map((r) => ({ policy: str(r.policy), protocol: str(r.protocol), destination: str(r.destCidr), port: str(r.destPort, "any") })) } };
    }
  }
};
