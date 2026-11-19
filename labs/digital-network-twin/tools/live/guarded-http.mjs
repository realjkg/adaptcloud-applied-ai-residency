// The only way a live adapter reaches the network.
//
// Fail-closed rules: https only, no credentials in the URL, the host must be one exact allowlisted name,
// loopback and link-local and metadata addresses are always refused, redirects are never followed, the
// response must be small JSON, and a timeout always applies. Credentials are built per request by a
// function the caller supplies, never stored here, and never appear in an error.
//
// NOT TESTED AGAINST A REAL SYSTEM. See docs/adr/0001-live-provisioning-authorization.md.

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export class HttpRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "HttpRefusal";
    this.code = code;
  }
}

/** Lowercases, strips IPv6 brackets, and removes trailing root dots, so "host." and "host" are one name. */
export const canonicalHost = (hostname) => String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

function isBlockedHost(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata" || host === "metadata.google.internal" || host.endsWith(".internal")) return true;
  if (host.includes(":")) return host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("::ffff:");
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    return a === 0 || a === 127 || (a === 169 && b === 254);
  }
  return false;
}

/**
 * @param {object} options
 * @param {string[]} options.allowedHosts exact host names, no wildcards
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 */
export function createGuardedHttp({ allowedHosts, fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = 1_000_000 }) {
  const allowed = new Set((allowedHosts ?? []).map(canonicalHost));
  if ([...allowed].some((host) => host.includes("*") || host.length === 0)) throw new Error("allowedHosts must be exact host names");

  /** @returns {Promise<{status:number, json:any}>} */
  return async function request({ method, url, headers = {}, body, auth }) {
    if (!METHODS.has(method)) throw new HttpRefusal("method_not_allowed");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpRefusal("url_invalid");
    }
    if (parsed.protocol !== "https:") throw new HttpRefusal("not_https");
    if (parsed.username || parsed.password) throw new HttpRefusal("userinfo_not_permitted");
    const host = canonicalHost(parsed.hostname);
    if (isBlockedHost(host)) throw new HttpRefusal("host_blocked");
    if (!allowed.has(host)) throw new HttpRefusal("host_not_allowlisted");

    const finalHeaders = { accept: "application/json", ...headers, ...(auth ? auth() : {}) };
    if (body !== undefined) finalHeaders["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(parsed.href, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: controller.signal });
      } catch {
        throw new HttpRefusal("transport_error");
      }
      if (response.status >= 300 && response.status < 400) throw new HttpRefusal("redirect_not_permitted");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new HttpRefusal("result_too_large");
      let text;
      try {
        text = await response.text();
      } catch {
        throw new HttpRefusal("transport_error");
      }
      if (text.length > maxBytes) throw new HttpRefusal("result_too_large");
      if (text.length === 0) return { status: response.status, json: null };
      if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) throw new HttpRefusal("content_type_not_allowed");
      try {
        return { status: response.status, json: JSON.parse(text) };
      } catch {
        throw new HttpRefusal("invalid_json");
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
