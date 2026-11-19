// Cloudflare adapter: DNS records only.
//
// Why only DNS records: a record is one object with a comment field, so ownership can be marked and a delete
// can be limited to what this twin created. A zone setting such as the SSL mode is a value on an object that
// already exists. Deleting it would have to restore whatever was there before, which this layer does not
// record, so it is refused as unsupported rather than guessed at. The managed WAF ruleset replaces a zone's
// whole rule entry point, which would overwrite rules this twin does not own.
//
// NOT TESTED AGAINST A REAL SYSTEM. Request shapes follow the Cloudflare v4 REST API as understood at the
// time of writing. See docs/adr/0001-live-provisioning-authorization.md.

import { secretFromEnv } from "./credentials.mjs";

const BASE = "https://api.cloudflare.com/client/v4";
const MARK = "twin-managed:";
const ZONE_ID = /^[a-f0-9]{32}$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const OWNER = /^[A-Za-z0-9._-]{1,64}$/;
const RECORD_ID = /^[a-f0-9]{32}$/;
const KNOWN = ["type", "content", "proxied"];

export const UNSUPPORTED_REASON = "only dns-record is implemented for Cloudflare; settings and rulesets cannot be owned or restored safely";

export function createCloudflareAdapter({ http, zoneId, env }) {
  if (!ZONE_ID.test(String(zoneId))) throw new Error("cloudflare zoneId must be a 32-character hex id");
  const auth = () => ({ authorization: `Bearer ${secretFromEnv(env, "CLOUDFLARE_API_TOKEN").reveal()}` });
  const call = (method, path, body) => http({ method, url: `${BASE}/zones/${zoneId}${path}`, auth, body });
  const ownerOf = (record) => (typeof record?.comment === "string" && record.comment.startsWith(MARK) ? record.comment.slice(MARK.length) : null);
  const normalize = (record) => ({
    vendor: "cloudflare", object: "dns-record", name: record.name,
    attributes: { type: record.type, content: record.content, proxied: record.proxied === true },
    managedBy: ownerOf(record)
  });

  async function list(name) {
    if (!HOSTNAME.test(name)) throw new Error("invalid record name");
    const response = await call("GET", `/dns_records?name=${encodeURIComponent(name)}`);
    if (response.status !== 200 || response.json?.success !== true || !Array.isArray(response.json.result)) throw new Error("cloudflare read failed");
    return response.json.result;
  }

  return {
    supports(op) {
      const attributes = op.attributes ?? {};
      return op.object === "dns-record" && HOSTNAME.test(op.name)
        && Object.keys(attributes).every((key) => KNOWN.includes(key))
        && ["A", "AAAA", "CNAME"].includes(attributes.type)
        && typeof attributes.content === "string" && attributes.content.length > 0
        && typeof attributes.proxied === "boolean";
    },

    async read(key) {
      const records = await list(key.name);
      if (records.length === 0) return null;
      // If this twin owns one, report that one. Otherwise report a record it does not own, which the engine treats as a conflict.
      const chosen = records.find((record) => ownerOf(record) !== null) ?? records[0];
      return normalize(chosen);
    },

    async create(key, attributes, owner) {
      // typeof first: RegExp.test() coerces, so test(undefined) would match the text "undefined".
      if (typeof owner !== "string" || !OWNER.test(owner) || typeof key.name !== "string" || !HOSTNAME.test(key.name)) throw new Error("invalid owner or name");
      const response = await call("POST", "/dns_records", { type: attributes.type, name: key.name, content: attributes.content, proxied: attributes.proxied, ttl: 1, comment: `${MARK}${owner}` });
      if (response.status !== 200 || response.json?.success !== true) throw new Error("cloudflare create failed");
    },

    async delete(key, owner) {
      const records = await list(key.name);
      const ours = records.filter((record) => ownerOf(record) === owner);
      if (ours.length === 0) return records.length > 0 ? { ok: false, reason: "unmanaged_object" } : { ok: true, outcome: "not_found" };
      for (const record of ours) {
        if (!RECORD_ID.test(String(record.id))) throw new Error("unexpected record id");
        const response = await call("DELETE", `/dns_records/${record.id}`);
        if (response.status !== 200 || response.json?.success !== true) throw new Error("cloudflare delete failed");
      }
      return { ok: true, outcome: "deleted" };
    }
  };
}
