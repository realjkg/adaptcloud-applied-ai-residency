// The allowlist of write targets. The server resolves a target by id. A browser never supplies a host, a URL, an API
// path, or a command: it names a target id and a change type from this list, plus the change's own fields.
//
// A live target must be a disposable lab target, name the exact change types it permits, and use only change types the
// live adapter implements. Credentials are named by environment variable here and read only at call time.

export const LIVE_CHANGE_TYPES = {
  paloalto: ["address-object.create", "address-object.delete"],
  meraki: ["l3-firewall-rule.add", "l3-firewall-rule.remove"]
};
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const ENVNAME = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Validates settings. Returns { problems } and, when none, the targets by id. */
export function loadTargets(list, { live }) {
  const problems = [];
  const byId = new Map();
  for (const [i, t] of (Array.isArray(list) ? list : []).entries()) {
    const at = `targets[${i}]`;
    if (typeof t?.id !== "string" || !ID.test(t.id)) { problems.push(`${at}.id is not valid`); continue; }
    if (byId.has(t.id)) problems.push(`${at}.id is a duplicate`);
    if (!["paloalto", "meraki"].includes(t.vendor)) problems.push(`${at}.vendor must be paloalto or meraki`);
    if (typeof t.label !== "string" || t.label.length === 0 || t.label.length > 80) problems.push(`${at}.label is required`);
    if (!Array.isArray(t.changeTypes) || t.changeTypes.length === 0) problems.push(`${at}.changeTypes must list the change types this target permits`);
    if (live) {
      if (t.environment !== "lab" || t.disposable !== true) problems.push(`${at} must be a disposable lab target`);
      if (!HOST.test(String(t.host ?? "")) || String(t.host).includes("*")) problems.push(`${at}.host must be an exact host name`);
      if (!ENVNAME.test(String(t.credentialEnv ?? ""))) problems.push(`${at}.credentialEnv must name an environment variable`);
      const supported = LIVE_CHANGE_TYPES[t.vendor] ?? [];
      for (const c of t.changeTypes ?? []) if (!supported.includes(c)) problems.push(`${at}.changeTypes includes ${c}, which has no live adapter`);
      if (t.vendor === "paloalto") for (const k of ["vsys", "deviceName", "commitAdmin"]) if (typeof t[k] !== "string" || !/^[A-Za-z0-9._-]{1,63}$/.test(t[k])) problems.push(`${at}.${k} is required`);
      if (t.vendor === "meraki" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(t.networkId ?? ""))) problems.push(`${at}.networkId is required`);
    }
    byId.set(t.id, t);
  }
  return problems.length ? { problems } : { problems: [], targets: byId };
}

/** What the browser may see. No host, no credential name. */
export const publicTarget = (t) => ({ id: t.id, label: t.label, vendor: t.vendor, environment: t.environment ?? "lab", disposable: t.disposable === true, changeTypes: t.changeTypes });
