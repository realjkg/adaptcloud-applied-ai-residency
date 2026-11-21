// In-memory fake of the Cloudflare and F5 REST behavior the live adapters assume.
//
// Passing tests against this fake shows the adapters are consistent with those assumptions. It does NOT show that
// the real vendor APIs behave this way. That is the whole risk of the live adapters.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hex32 = (n) => n.toString(16).padStart(32, "0");

export const CF_TOKEN = "SYNTH-CF-TOKEN-VALUE";
export const BIGIP_USER = "synth-user";
export const BIGIP_PASS = "SYNTH-BIGIP-PASSWORD";
export const ZONE_ID = hex32(0xabc);
export const F5_HOST = "10.20.0.10";
export const ENV = { CLOUDFLARE_API_TOKEN: CF_TOKEN, BIGIP_USERNAME: BIGIP_USER, BIGIP_PASSWORD: BIGIP_PASS };

/**
 * @param {object} [options]
 * @param {string[]} [options.failPostOn] F5 collections whose POST returns 500, such as "virtual"
 * @param {boolean} [options.corruptVirtual] return a changed destination when reading a virtual server
 * @param {boolean} [options.escapeSend] return monitor send strings with escaped CR and LF
 * @param {boolean} [options.failReads] every GET returns 500
 * @param {boolean} [options.ignoreNameFilter] the Cloudflare list returns every record, as if the filter were ignored
 * @param {number} [options.dnsPages] total_pages reported by the Cloudflare list
 */
export function createFakeVendors({ failPostOn = [], corruptVirtual = false, escapeSend = false, failReads = false, ignoreNameFilter = false, dnsPages = 1 } = {}) {
  const requests = [];
  const dns = [];
  const f5 = { monitor: new Map(), pool: new Map(), virtual: new Map(), members: new Map() };
  let counter = 1;

  const expectedBasic = `Basic ${Buffer.from(`${BIGIP_USER}:${BIGIP_PASS}`).toString("base64")}`;

  async function cloudflare(method, parts, url, body) {
    // parts: ["client", "v4", "zones", zone, "dns_records", id?]
    if (parts[3] !== ZONE_ID) return json(404, { success: false });
    if (parts[4] !== "dns_records") return json(404, { success: false });
    if (method === "GET") {
      if (failReads) return json(500, { success: false });
      // The documented filter is name.exact, and filters are case-insensitive. An API that ignored it would return every record.
      const wanted = url.searchParams.get("name.exact");
      const matches = ignoreNameFilter || wanted === null ? dns : dns.filter((record) => record.name.toLowerCase() === wanted.toLowerCase());
      return json(200, { success: true, result: matches, result_info: { page: 1, per_page: 100, count: matches.length, total_count: dns.length, total_pages: dnsPages } });
    }
    if (method === "POST") {
      const record = { id: hex32(counter++), type: body.type, name: body.name, content: body.content, proxied: body.proxied, ttl: body.ttl, comment: body.comment };
      dns.push(record);
      return json(200, { success: true, result: record });
    }
    if (method === "DELETE") {
      const index = dns.findIndex((record) => record.id === parts[5]);
      if (index < 0) return json(404, { success: false });
      dns.splice(index, 1);
      // The documented delete response is { result: { id } } with no success flag.
      return json(200, { result: { id: parts[5] } });
    }
    return json(405, { success: false });
  }

  const unname = (segment) => decodeURIComponent(segment).replace(/^~Common~/, "");

  async function bigip(method, parts, url, body) {
    // parts: ["mgmt","tm","ltm", kind, ...]
    const kind = parts[3];
    if (method === "GET" && failReads) return json(500, { message: "boom" });
    if (kind === "monitor") {
      const name = parts[5] && unname(parts[5]);
      if (method === "GET") {
        const item = f5.monitor.get(name);
        if (!item) return json(404, { message: "not found" });
        return json(200, escapeSend ? { ...item, send: item.send.replaceAll("\r", "\\r").replaceAll("\n", "\\n") } : item);
      }
      if (method === "POST") {
        if (failPostOn.includes("monitor")) return json(500, { message: "boom" });
        if (f5.monitor.has(body.name)) return json(409, { message: "already exists" });
        f5.monitor.set(body.name, { ...body, fullPath: `/Common/${body.name}` });
        return json(200, body);
      }
      if (method === "DELETE") {
        if (!f5.monitor.has(name)) return json(404, { message: "not found" });
        if ([...f5.pool.values()].some((pool) => pool.monitor === `/Common/${name}`)) return json(400, { message: `monitor ${name} is referenced by a pool` });
        f5.monitor.delete(name);
        return json(200, {});
      }
    }
    if (kind === "pool") {
      const poolName = parts[4] && unname(parts[4]);
      if (parts[5] === "members") {
        const member = parts[6] && unname(parts[6]);
        if (!f5.pool.has(poolName)) return json(404, { message: "pool not found" });
        if (method === "POST") {
          if (failPostOn.includes("members")) return json(500, { message: "boom" });
          const key = `${poolName}/${body.name}`;
          if (f5.members.has(key)) return json(409, { message: "already exists" });
          f5.members.set(key, { ...body });
          return json(200, body);
        }
        const key = `${poolName}/${member}`;
        if (method === "GET") return f5.members.has(key) ? json(200, f5.members.get(key)) : json(404, { message: "not found" });
        if (method === "DELETE") {
          if (!f5.members.has(key)) return json(404, { message: "not found" });
          f5.members.delete(key);
          return json(200, {});
        }
      }
      if (method === "GET") return f5.pool.has(poolName) ? json(200, f5.pool.get(poolName)) : json(404, { message: "not found" });
      if (method === "POST") {
        if (failPostOn.includes("pool")) return json(500, { message: "boom" });
        if (f5.pool.has(body.name)) return json(409, { message: "already exists" });
        f5.pool.set(body.name, { ...body });
        return json(200, body);
      }
      if (method === "DELETE") {
        if (!f5.pool.has(poolName)) return json(404, { message: "not found" });
        if ([...f5.members.keys()].some((key) => key.startsWith(`${poolName}/`))) return json(400, { message: `pool ${poolName} has members and is referenced` });
        if ([...f5.virtual.values()].some((vs) => vs.pool === `/Common/${poolName}`)) return json(400, { message: `pool ${poolName} is in use by a virtual server` });
        f5.pool.delete(poolName);
        return json(200, {});
      }
    }
    if (kind === "virtual") {
      const name = parts[4] && unname(parts[4]);
      if (method === "GET") {
        const item = f5.virtual.get(name);
        if (!item) return json(404, { message: "not found" });
        const shaped = { ...item, profilesReference: { items: item.profiles } };
        return json(200, corruptVirtual ? { ...shaped, destination: "/Common/10.99.99.99:443" } : shaped);
      }
      if (method === "POST") {
        if (failPostOn.includes("virtual")) return json(500, { message: "boom" });
        if (f5.virtual.has(body.name)) return json(409, { message: "already exists" });
        f5.virtual.set(body.name, { ...body });
        return json(200, body);
      }
      if (method === "DELETE") {
        if (!f5.virtual.has(name)) return json(404, { message: "not found" });
        f5.virtual.delete(name);
        return json(200, {});
      }
    }
    return json(404, { message: "no such route" });
  }

  async function fetchImpl(href, init = {}) {
    const url = new URL(href);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, host: url.hostname, path: url.pathname, search: url.search, headers, redirect: init.redirect, body });
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "api.cloudflare.com") {
      if (headers.authorization !== `Bearer ${CF_TOKEN}`) return json(403, { success: false });
      return cloudflare(method, parts, url, body);
    }
    if (url.hostname === F5_HOST) {
      if (headers.authorization !== expectedBasic) return json(401, { message: "unauthorized" });
      return bigip(method, parts, url, body);
    }
    return json(404, {});
  }

  return {
    fetchImpl,
    requests,
    dns,
    f5,
    writes: () => requests.filter((request) => request.method !== "GET").length,
    seedDns(record) {
      dns.push({ id: hex32(counter++), ttl: 1, ...record });
    },
    seedF5(kind, item) {
      if (kind === "pool-member") f5.members.set(`${item.pool}/${item.name}`, { name: item.name });
      else f5[kind === "virtual-server" ? "virtual" : kind].set(item.name, { ...item });
    },
    snapshot() {
      return JSON.stringify({ dns, monitor: [...f5.monitor], pool: [...f5.pool], members: [...f5.members], virtual: [...f5.virtual] });
    }
  };
}
