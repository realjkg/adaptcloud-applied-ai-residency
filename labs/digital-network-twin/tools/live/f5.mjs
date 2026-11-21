// F5 BIG-IP adapter over iControl REST: HTTP monitor, pool, pool member, and virtual server.
//
// Ownership is marked in each object's description. An object without this twin's mark is never deleted.
//
// Not implemented, and refused as unsupported: ssl-certificate and client-ssl-profile. A certificate needs a
// file upload and the profile needs a TLS option design. The virtual server only references an existing
// client SSL profile, so install and review that profile separately.
//
// Known residue: BIG-IP creates a node automatically when a pool member is added, and that node stays after
// the member is deleted. The node carries no ownership mark, so this adapter leaves it for a person to review.
// This adapter changes the running configuration only. Saving it and any HA sync are left to a person.
//
// NOT TESTED AGAINST A REAL SYSTEM. Request shapes follow iControl REST as understood at the time of writing;
// attribute names and the read-back normalization are the most likely places to need adjustment.
// See docs/adr/0001-live-provisioning-authorization.md.

import { secretFromEnv } from "./credentials.mjs";

const MARK = "twin-managed:";
const NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const OWNER = /^[A-Za-z0-9._-]{1,64}$/;
const ADDRESS_PORT = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

export const UNSUPPORTED_REASON = "implemented: monitor, pool, pool-member, virtual-server; certificates and client SSL profiles are not";

// A strict string check. RegExp.test() coerces its argument, so test(undefined) would match the text "undefined".
const isName = (value) => typeof value === "string" && NAME.test(value);
const isAddressPort = (value) => typeof value === "string" && ADDRESS_PORT.test(value);
const tilde = (name) => `~Common~${name}`;
const strip = (value) => String(value ?? "").replace(/^\/Common\//, "");
// iControl may return the send string with escaped CR and LF. Compare on the unescaped form.
const unescapeCrlf = (value) => String(value ?? "").replaceAll("\\r", "\r").replaceAll("\\n", "\n");

export function createF5Adapter({ http, host, env }) {
  if (!HOST.test(String(host))) throw new Error("f5 host must be a plain host name or address");
  const root = `https://${host}/mgmt/tm/ltm`;
  const auth = () => {
    const user = secretFromEnv(env, "BIGIP_USERNAME").reveal();
    const pass = secretFromEnv(env, "BIGIP_PASSWORD").reveal();
    return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
  };
  const call = (method, url, body) => http({ method, url, auth, body });
  const ownerOf = (item) => (typeof item?.description === "string" && item.description.startsWith(MARK) ? item.description.slice(MARK.length) : null);

  async function getOne(url) {
    const response = await call("GET", url);
    if (response.status === 404) return null;
    if (response.status !== 200 || !response.json) throw new Error("f5 read failed");
    return response.json;
  }

  const KINDS = {
    monitor: {
      keys: ["type", "send", "receive"],
      ok: (a) => a.type === "http" && typeof a.send === "string" && typeof a.receive === "string",
      url: (key) => `${root}/monitor/http/${tilde(key.name)}`,
      collection: () => `${root}/monitor/http`,
      body: (key, a, owner) => ({ name: key.name, partition: "Common", send: a.send, recv: a.receive, interval: 5, timeout: 16, description: `${MARK}${owner}` }),
      normalize: (item) => ({ type: "http", send: unescapeCrlf(item.send), receive: String(item.recv ?? "") })
    },
    pool: {
      keys: ["method"],
      ok: (a) => a.method === "round-robin",
      url: (key) => `${root}/pool/${tilde(key.name)}`,
      collection: () => `${root}/pool`,
      // The monitor is attached by the twin's naming convention: <pool>-monitor.
      body: (key, a, owner) => ({ name: key.name, partition: "Common", loadBalancingMode: a.method, monitor: `/Common/${key.name}-monitor`, description: `${MARK}${owner}` }),
      normalize: (item) => ({ method: item.loadBalancingMode })
    },
    "pool-member": {
      keys: ["pool"],
      ok: (a, name) => isAddressPort(name) && isName(a.pool),
      url: (key, ctx) => `${root}/pool/${tilde(ctx.pool)}/members/${tilde(key.name)}`,
      collection: (key, ctx) => `${root}/pool/${tilde(ctx.pool)}/members`,
      body: (key, a, owner) => ({ name: key.name, partition: "Common", description: `${MARK}${owner}` }),
      normalize: (item, ctx) => ({ pool: ctx.pool })
    },
    "virtual-server": {
      keys: ["destination", "pool", "clientSslProfile", "snat"],
      ok: (a) => isAddressPort(a.destination) && isName(a.pool) && isName(a.clientSslProfile) && a.snat === "automap",
      url: (key) => `${root}/virtual/${tilde(key.name)}`,
      readSuffix: "?expandSubcollections=true",
      collection: () => `${root}/virtual`,
      body: (key, a, owner) => ({
        name: key.name, partition: "Common", destination: `/Common/${a.destination}`, pool: `/Common/${a.pool}`,
        sourceAddressTranslation: { type: "automap" },
        profiles: [{ name: "tcp", partition: "Common", context: "all" }, { name: a.clientSslProfile, partition: "Common", context: "clientside" }],
        description: `${MARK}${owner}`
      }),
      normalize: (item) => ({
        destination: strip(item.destination), pool: strip(item.pool),
        clientSslProfile: item.profilesReference?.items?.find((profile) => profile.context === "clientside")?.name ?? "",
        snat: item.sourceAddressTranslation?.type
      })
    }
  };

  function kindFor(key, ctx) {
    const kind = KINDS[key.object];
    if (!kind || !isName(key.name)) throw new Error("unsupported object or invalid name");
    if (key.object === "pool-member" && !isName(ctx?.pool)) throw new Error("pool member needs its pool");
    return kind;
  }

  return {
    supports(op) {
      const kind = KINDS[op.object];
      const attributes = op.attributes ?? {};
      return Boolean(kind) && isName(op.name) && Object.keys(attributes).every((key) => kind.keys.includes(key)) && kind.ok(attributes, op.name);
    },

    async read(key, ctx) {
      const kind = kindFor(key, ctx);
      const item = await getOne(`${kind.url(key, ctx)}${kind.readSuffix ?? ""}`);
      if (!item) return null;
      return { vendor: "f5", object: key.object, name: key.name, attributes: kind.normalize(item, ctx), managedBy: ownerOf(item) };
    },

    async create(key, attributes, owner) {
      const kind = kindFor(key, attributes);
      if (typeof owner !== "string" || !OWNER.test(owner)) throw new Error("invalid owner");
      const response = await call("POST", kind.collection(key, attributes), kind.body(key, attributes, owner));
      if (response.status !== 200 && response.status !== 201) throw new Error("f5 create failed");
    },

    async delete(key, owner, ctx) {
      const kind = kindFor(key, ctx);
      const item = await getOne(kind.url(key, ctx));
      if (!item) return { ok: true, outcome: "not_found" };
      if (ownerOf(item) !== owner) return { ok: false, reason: "unmanaged_object" };
      const response = await call("DELETE", kind.url(key, ctx));
      if (response.status === 200 || response.status === 204) return { ok: true, outcome: "deleted" };
      if (response.status === 400 && /referenced|in use/i.test(String(response.json?.message ?? ""))) return { ok: false, reason: "in_use" };
      throw new Error("f5 delete failed");
    }
  };
}
