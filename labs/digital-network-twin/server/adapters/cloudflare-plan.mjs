// Cloudflare edge configuration: planning. Pure, with no network and no credentials, so the simulator and the live adapter
// share it.
//
// Edge behavior is changed through the Rulesets API: a phase has one entry point ruleset per zone, and a rule is added to
// it, or removed from it, WITHOUT rewriting the other rules. That is the main difference from replace-the-whole-list APIs:
// a single-rule add or delete cannot overwrite anyone else's rule, so no exclusive change window is needed.
//
// First scope: three structured rule types and one rollback-only removal.
//   waf-custom-rule.add   phase http_request_firewall_custom       block, managed_challenge, js_challenge, or log
//   redirect-rule.add     phase http_request_dynamic_redirect      static redirect to an https URL
//   cache-rule.add        phase http_request_cache_settings        bypass cache, or eligible with an optional edge TTL
//   edge-rule.remove      any of those phases                      only a rule this system added, and only if unchanged
//
// A browser never supplies a wirefilter expression. It supplies one condition (field, operator, value) from a closed list,
// and the server builds the expression from validated parts. Values may not contain quotes, backslashes, or spaces, so no
// escaping exists to get wrong.

import { listDiff, markFor, same } from "./common.mjs";

export const PHASES = { "waf-custom-rule": "http_request_firewall_custom", "redirect-rule": "http_request_dynamic_redirect", "cache-rule": "http_request_cache_settings" };
const PHASE_SET = new Set(Object.values(PHASES));

const FIELDS = {
  host: { cf: "http.host", ops: ["eq"], valid: (v) => /^[A-Za-z0-9.-]{1,253}$/.test(v) },
  path: { cf: "http.request.uri.path", ops: ["eq", "starts_with", "contains"], valid: (v) => /^\/[A-Za-z0-9._~/%:@!$&'()*+,;=-]{0,199}$/.test(v) },
  country: { cf: "ip.src.country", ops: ["eq"], valid: (v) => /^[A-Z]{2}$/.test(v) },
  ip: { cf: "ip.src", ops: ["in"], valid: (v) => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(v) && v.split("/")[0].split(".").every((o) => Number(o) <= 255) && (!v.includes("/") || Number(v.split("/")[1]) <= 32) }
};
export const CONDITION_FIELDS = Object.keys(FIELDS);
export const CONDITION_OPS = ["eq", "starts_with", "contains", "in"];
const TEXT = /^[A-Za-z0-9 ._:,-]{1,120}$/;

/** Validates the flat condition fields a browser form submits. Returns a list of problems. */
export function validateCondition(p) {
  const bad = [];
  const f = FIELDS[p.conditionField];
  if (!f) { bad.push(`conditionField must be one of ${CONDITION_FIELDS.join(", ")}`); return bad; }
  if (!f.ops.includes(p.conditionOp)) bad.push(`conditionOp for ${p.conditionField} must be one of ${f.ops.join(", ")}`);
  if (typeof p.conditionValue !== "string" || !f.valid(p.conditionValue)) bad.push("conditionValue is not valid for that field");
  return bad;
}

/** Builds the expression from validated parts only. */
export function buildExpression(p) {
  const f = FIELDS[p.conditionField];
  const v = p.conditionValue;
  if (p.conditionOp === "eq") return `(${f.cf} eq "${v}")`;
  if (p.conditionOp === "contains") return `(${f.cf} contains "${v}")`;
  if (p.conditionOp === "starts_with") return `(starts_with(${f.cf}, "${v}"))`;
  return `(${f.cf} in {${v}})`;
}

/** What a request would do under one condition, for the synthetic traffic preview. */
export function matches(p, request) {
  const v = p.conditionValue;
  const actual = { host: request.host, path: request.path, country: request.country, ip: request.ip }[p.conditionField];
  if (p.conditionField === "ip") return v.includes("/") ? inCidr(actual, v) : actual === v;
  if (p.conditionOp === "eq") return actual === v;
  if (p.conditionOp === "starts_with") return actual.startsWith(v);
  return actual.includes(v);
}
const toInt = (ip) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const inCidr = (ip, cidr) => { const [base, bits] = cidr.split("/"); const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0; return (toInt(ip) & mask) === (toInt(base) & mask); };

/** A fixed synthetic traffic sample. Used only to show what a new rule would touch; it is not a measurement of real traffic. */
export const TRAFFIC_SAMPLE = [
  { host: "www.shop.test", path: "/", country: "US", ip: "203.0.113.10" },
  { host: "www.shop.test", path: "/products/shoes", country: "US", ip: "203.0.113.11" },
  { host: "www.shop.test", path: "/products/hats", country: "GB", ip: "198.51.100.20" },
  { host: "www.shop.test", path: "/checkout", country: "US", ip: "203.0.113.12" },
  { host: "www.shop.test", path: "/checkout/pay", country: "DE", ip: "192.0.2.44" },
  { host: "www.shop.test", path: "/login", country: "FR", ip: "192.0.2.45" },
  { host: "www.shop.test", path: "/login", country: "RU", ip: "198.51.100.77" },
  { host: "www.shop.test", path: "/admin", country: "US", ip: "203.0.113.200" },
  { host: "www.shop.test", path: "/admin/users", country: "CN", ip: "198.51.100.99" },
  { host: "api.shop.test", path: "/v1/items", country: "US", ip: "203.0.113.30" },
  { host: "api.shop.test", path: "/v1/items/42", country: "GB", ip: "203.0.113.31" },
  { host: "api.shop.test", path: "/v1/orders", country: "US", ip: "203.0.113.32" },
  { host: "api.shop.test", path: "/v1/health", country: "US", ip: "192.0.2.10" },
  { host: "static.shop.test", path: "/img/logo.png", country: "US", ip: "203.0.113.40" },
  { host: "static.shop.test", path: "/img/banner.jpg", country: "BR", ip: "198.51.100.41" },
  { host: "static.shop.test", path: "/js/app.js", country: "IN", ip: "198.51.100.42" },
  { host: "static.shop.test", path: "/css/site.css", country: "US", ip: "203.0.113.43" },
  { host: "old.shop.test", path: "/", country: "US", ip: "203.0.113.50" },
  { host: "old.shop.test", path: "/contact-us", country: "GB", ip: "203.0.113.51" },
  { host: "www.shop.test", path: "/search", country: "AU", ip: "198.51.100.60" }
];

const phaseOf = (type) => PHASES[type.split(".")[0]];
const stable = (v) => (v === undefined ? null : v);

/** The fields of a rule this system compares: server-assigned id, version, and timestamps are left out. */
export function normalizeRule(r) {
  return { ref: r.ref ?? null, description: r.description ?? "", action: r.action, expression: r.expression ?? "", enabled: r.enabled !== false, action_parameters: stable(r.action_parameters) };
}
export const compact = (state) => ({ exists: state.exists, rules: state.rules.map(normalizeRule) });
const renderRule = (r) => `${r.action} ${r.expression}${r.ref ? ` [${r.ref}]` : ""}${r.description ? ` # ${r.description}` : ""}${r.enabled ? "" : " (disabled)"}`;

function buildRule(type, p, opId) {
  const base = { ref: `twin-${opId.toLowerCase()}`, description: `${markFor(opId)} ${p.comment}`.slice(0, 200), expression: buildExpression(p), enabled: true };
  if (type === "waf-custom-rule.add") return { ...base, action: p.action, action_parameters: null };
  if (type === "redirect-rule.add") return { ...base, action: "redirect", action_parameters: { from_value: { target_url: { value: p.targetUrl }, status_code: Number(p.statusCode), preserve_query_string: p.preserveQuery === "yes" } } };
  return { ...base, action: "set_cache_settings", action_parameters: p.cacheMode === "bypass" ? { cache: false } : { cache: true, ...(p.edgeTtl ? { edge_ttl: { mode: "override_origin", default: Number(p.edgeTtl) } } : {}) } };
}

const COND_FIELDS = [
  { name: "conditionField", label: "Match on", options: CONDITION_FIELDS },
  { name: "conditionOp", label: "Operator", options: ["eq", "starts_with", "contains", "in"] },
  { name: "conditionValue", label: "Value (no spaces or quotes)" }
];

export const CHANGE_TYPES = {
  "waf-custom-rule.add": {
    label: "Add a WAF custom rule (block, challenge, or log)",
    fields: [...COND_FIELDS, { name: "action", label: "Action", options: ["block", "managed_challenge", "js_challenge", "log"] }, { name: "comment", label: "Comment" }],
    validate(p) {
      const bad = validateCondition(p);
      if (!["block", "managed_challenge", "js_challenge", "log"].includes(p.action)) bad.push("action must be block, managed_challenge, js_challenge, or log");
      if (typeof p.comment !== "string" || !TEXT.test(p.comment)) bad.push("comment must be 1 to 120 plain characters");
      return bad;
    }
  },
  "redirect-rule.add": {
    label: "Add a redirect rule (static https target)",
    fields: [...COND_FIELDS, { name: "targetUrl", label: "Redirect to (https URL)" }, { name: "statusCode", label: "Status code", options: ["302", "307", "301", "308"] }, { name: "preserveQuery", label: "Keep query string", options: ["no", "yes"] }, { name: "comment", label: "Comment" }],
    validate(p) {
      const bad = validateCondition(p);
      if (typeof p.targetUrl !== "string" || !/^https:\/\/[A-Za-z0-9.-]{1,253}(\/[A-Za-z0-9._~/%:@!$&'()*+,;=-]{0,200})?$/.test(p.targetUrl)) bad.push("targetUrl must be an https URL with a plain path");
      if (!["301", "302", "307", "308"].includes(String(p.statusCode))) bad.push("statusCode must be 301, 302, 307, or 308");
      if (!["yes", "no"].includes(p.preserveQuery ?? "no")) bad.push("preserveQuery must be yes or no");
      if (typeof p.comment !== "string" || !TEXT.test(p.comment)) bad.push("comment must be 1 to 120 plain characters");
      return bad;
    }
  },
  "cache-rule.add": {
    label: "Add a cache rule (bypass, or eligible with an edge TTL)",
    fields: [...COND_FIELDS, { name: "cacheMode", label: "Cache", options: ["bypass", "eligible"] }, { name: "edgeTtl", label: "Edge TTL seconds (optional, eligible only)", optional: true }, { name: "comment", label: "Comment" }],
    validate(p) {
      const bad = validateCondition(p);
      if (!["bypass", "eligible"].includes(p.cacheMode)) bad.push("cacheMode must be bypass or eligible");
      if (p.edgeTtl !== undefined && p.edgeTtl !== "" && (p.cacheMode !== "eligible" || !/^[1-9][0-9]{0,8}$/.test(String(p.edgeTtl)))) bad.push("edgeTtl must be a positive number of seconds and only with eligible");
      if (typeof p.comment !== "string" || !TEXT.test(p.comment)) bad.push("comment must be 1 to 120 plain characters");
      return bad;
    }
  },
  "edge-rule.remove": {
    label: "Remove a rule this system added (by its mark)",
    rollbackOnly: true,
    validate(p) {
      const bad = [];
      if (!PHASE_SET.has(p.phase)) bad.push("phase is not a supported edge phase");
      if (typeof p.mark !== "string" || !/^OP-[0-9A-F]{10}$/.test(p.mark)) bad.push("mark must be an operation id");
      return bad;
    }
  }
};
for (const [type, def] of Object.entries(CHANGE_TYPES)) {
  if (type.endsWith(".add")) {
    def.inverse = (p, { opId, created }) => ({ changeType: "edge-rule.remove", params: { phase: phaseOf(type), mark: opId, expected: created?.rules?.find((r) => r.ref === `twin-${opId.toLowerCase()}`) ?? null } });
  } else def.inverse = () => null;
}

/** @returns {{ proposed, diff, blockers, requiresExclusiveWindow, commitScope, preview, phase }} */
export function planEdge({ changeType, params, state, opId }) {
  const phase = changeType === "edge-rule.remove" ? params.phase : phaseOf(changeType);
  const before = compact(state);
  let after;
  const blockers = [];
  let preview = null;
  if (changeType === "edge-rule.remove") {
    const mark = `twin-${params.mark.toLowerCase()}`;
    const hits = before.rules.filter((r) => r.ref === mark);
    if (hits.length !== 1) blockers.push(hits.length === 0 ? "no_rule_with_that_mark" : "mark_is_ambiguous");
    else if (params.expected && !same(hits[0], normalizeRule(params.expected))) blockers.push("rule_changed_since_creation");
    after = { exists: before.exists, rules: before.rules.filter((r) => r.ref !== mark) };
  } else {
    const rule = normalizeRule(buildRule(changeType, params, opId));
    if (before.rules.some((r) => r.ref === rule.ref)) blockers.push("rule_ref_already_exists");
    after = { exists: true, rules: [...before.rules, rule] };
    const hit = TRAFFIC_SAMPLE.filter((r) => matches(params, r));
    preview = { kind: "synthetic_traffic_sample", sampleSize: TRAFFIC_SAMPLE.length, matched: hit.length, effect: changeType === "waf-custom-rule.add" ? params.action : changeType === "redirect-rule.add" ? `redirect ${params.statusCode}` : params.cacheMode === "bypass" ? "bypass cache" : `cache${params.edgeTtl ? `, edge TTL ${params.edgeTtl}s` : ""}`, examples: hit.slice(0, 5).map((r) => `${r.host}${r.path} from ${r.country}`), existingRulesNotEvaluated: before.rules.length, note: "A fixed synthetic sample, not real traffic. Existing rules are not evaluated." };
  }
  // Other people's rules are untouched by construction: a single-rule add or delete does not rewrite the list.
  const others = after.rules.filter((r) => !(r.ref ?? "").startsWith("twin-")).length === before.rules.filter((r) => !(r.ref ?? "").startsWith("twin-")).length;
  const diff = { ...listDiff(before.rules, after.rules, renderRule), unrelatedRulesUnchanged: others && before.rules.every((b) => after.rules.some((a) => same(a, b)) || (changeType === "edge-rule.remove" && b.ref === `twin-${params.mark.toLowerCase()}`)) };
  return { phase, proposed: after, diff, blockers: diff.unrelatedRulesUnchanged ? blockers : [...blockers, "unrelated_rules_would_change"], requiresExclusiveWindow: false, commitScope: null, preview };
}
