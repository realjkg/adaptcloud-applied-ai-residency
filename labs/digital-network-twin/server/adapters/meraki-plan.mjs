// Meraki MX planning: L3 firewall rules. Pure, with no network and no credentials, so the simulator can use it.
//
// The L3 rules endpoint replaces the whole ordered list and documents no conditional update. So this adapter:
//   - reads the whole list and refuses if it cannot be faithfully round-tripped (unknown fields, odd values),
//   - shows the approver the entire before and after lists and proves the unrelated rules are unchanged,
//   - requires the approver to confirm an exclusive change window, because a fresh read cannot stop an edit made
//     during the write,
//   - reads the list back and compares it with the plan. A mismatch is reported, never repaired.
// The default rule is not part of the PUT body and is left alone.

import { listDiff, markFor, same } from "./common.mjs";

const KNOWN = ["comment", "policy", "protocol", "srcPort", "srcCidr", "destPort", "destCidr", "syslogEnabled"];
const CIDR = /^(any|Any|(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?|(VLAN|OBJ|GRP)\([A-Za-z0-9._,:/ -]{1,80}\))$/;
const PORT = /^(any|Any|\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?){0,10})$/;
const TEXT = /^[A-Za-z0-9 ._:,-]{0,120}$/;

const strip = (rules) => rules.filter((r, i) => !(i === rules.length - 1 && r?.comment === "Default rule"));

/** Returns the rule fields this adapter can reproduce, or null when a rule has anything it cannot. */
export function normalizeRules(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const rule of strip(raw)) {
    if (typeof rule !== "object" || rule === null) return null;
    if (Object.keys(rule).some((k) => !KNOWN.includes(k))) return null;
    for (const k of ["comment", "policy", "protocol", "srcPort", "srcCidr", "destPort", "destCidr"]) if (typeof rule[k] !== "string") return null;
    if (rule.syslogEnabled !== undefined && typeof rule.syslogEnabled !== "boolean") return null;
    out.push({ comment: rule.comment, policy: rule.policy, protocol: rule.protocol, srcPort: rule.srcPort, srcCidr: rule.srcCidr, destPort: rule.destPort, destCidr: rule.destCidr, syslogEnabled: rule.syslogEnabled === true });
  }
  return out;
}

const renderRule = (r) => `${r.policy} ${r.protocol} ${r.srcCidr}:${r.srcPort} -> ${r.destCidr}:${r.destPort}${r.comment ? ` # ${r.comment}` : ""}`;

export const CHANGE_TYPES = {
  "l3-firewall-rule.add": {
    label: "Add an L3 firewall rule before the default rule",
    fields: [{ name: "policy", label: "Policy", options: ["allow", "deny"] }, { name: "protocol", label: "Protocol", options: ["tcp", "udp", "icmp", "any"] }, { name: "srcCidr", label: "Source CIDR" }, { name: "srcPort", label: "Source port" }, { name: "destCidr", label: "Destination CIDR" }, { name: "destPort", label: "Destination port" }, { name: "comment", label: "Comment" }],
    validate(p) {
      const bad = [];
      if (!["allow", "deny"].includes(p.policy)) bad.push("policy must be allow or deny");
      if (!["tcp", "udp", "icmp", "any"].includes(p.protocol)) bad.push("protocol must be tcp, udp, icmp, or any");
      for (const k of ["srcCidr", "destCidr"]) if (typeof p[k] !== "string" || !CIDR.test(p[k])) bad.push(`${k} is not valid`);
      for (const k of ["srcPort", "destPort"]) if (typeof p[k] !== "string" || !PORT.test(p[k])) bad.push(`${k} is not valid`);
      if (typeof p.comment !== "string" || !TEXT.test(p.comment) || p.comment.length === 0) bad.push("comment must be 1 to 120 plain characters");
      return bad;
    },
    plan(state, p, { opId }) {
      const rule = { comment: `${markFor(opId)} ${p.comment}`.slice(0, 120), policy: p.policy, protocol: p.protocol, srcPort: p.srcPort, srcCidr: p.srcCidr, destPort: p.destPort, destCidr: p.destCidr, syslogEnabled: false };
      const proposed = { rules: [...state.rules, rule] };
      return { proposed, blockers: [] };
    },
    inverse: (p, { opId, created }) => ({ changeType: "l3-firewall-rule.remove", params: { mark: opId, expected: created?.rules?.find((r) => r.comment.startsWith(markFor(opId))) ?? null } })
  },
  "l3-firewall-rule.remove": {
    label: "Remove a rule this system added (by its mark)",
    rollbackOnly: true,
    validate: (p) => (typeof p.mark === "string" && /^OP-[0-9A-F]{10}$/.test(p.mark) ? [] : ["mark must be an operation id"]),
    plan(state, p) {
      const hits = state.rules.filter((r) => r.comment.startsWith(markFor(p.mark)));
      if (hits.length !== 1) return { proposed: state, blockers: [hits.length === 0 ? "no_rule_with_that_mark" : "mark_is_ambiguous"] };
      if (p.expected && !same(hits[0], p.expected)) return { proposed: state, blockers: ["rule_changed_since_creation"] };
      return { proposed: { rules: state.rules.filter((r) => r !== hits[0]) }, blockers: [] };
    },
    inverse: () => null
  }
};

/** Shared planning: checks the round trip, builds the proposed list, and proves unrelated rules are unchanged. */
export function planRules({ changeType, params, state, opId }) {
  const def = CHANGE_TYPES[changeType];
  const { proposed, blockers } = def.plan(state, params, { opId });
  const diff = listDiff(state.rules, proposed.rules, renderRule);
  const kept = proposed.rules.filter((r) => state.rules.some((b) => same(b, r)));
  const unrelatedUnchanged = state.rules.every((b) => kept.some((r) => same(r, b)) || (changeType === "l3-firewall-rule.remove" && b.comment.startsWith(markFor(params.mark))));
  return { proposed, diff: { ...diff, unrelatedRulesUnchanged: unrelatedUnchanged }, blockers: unrelatedUnchanged ? blockers : [...blockers, "unrelated_rules_would_change"], requiresExclusiveWindow: true, commitScope: null };
}

