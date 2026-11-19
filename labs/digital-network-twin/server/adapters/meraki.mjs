// Meraki MX write adapter: L3 firewall rules. NOT TESTED AGAINST A REAL SYSTEM. See meraki-plan.mjs for the rules it follows.

import { secretFromEnv } from "../../tools/live/credentials.mjs";
import { guardedWrite, WriteError } from "./common.mjs";
import { CHANGE_TYPES, normalizeRules, planRules } from "./meraki-plan.mjs";
export { CHANGE_TYPES, normalizeRules, planRules };

export function createMerakiAdapter({ http, target, env }) {
  const auth = () => ({ authorization: `Bearer ${secretFromEnv(env, target.credentialEnv).reveal()}` });
  const url = `https://${target.host}/api/v1/networks/${encodeURIComponent(target.networkId)}/appliance/firewall/l3FirewallRules`;
  const get = async () => {
    const r = await http({ method: "GET", url, auth });
    if (r.status === 404) throw new WriteError("network_not_found_or_key_rejected", 404);
    if (r.status === 429) throw new WriteError("rate_limited", 429);
    if (r.status !== 200) throw new WriteError("read_failed", r.status);
    const rules = normalizeRules(r.json?.rules);
    if (rules === null) throw new WriteError("list_not_round_trippable", 422);
    return { rules };
  };
  return {
    vendor: "meraki",
    changeTypes: CHANGE_TYPES,
    readState: () => get(),
    async plan({ changeType, params, opId }) {
      const state = await get();
      return { baseline: state, ...planRules({ changeType, params, state, opId }) };
    },
    async execute(plan) {
      const write = async () => {
        const r = await http({ method: "PUT", url, auth, body: { rules: plan.proposed.rules } });
        if (r.status >= 400) throw new WriteError("write_refused", r.status);
      };
      return guardedWrite({ write, read: get, baseline: plan.baseline, proposed: plan.proposed });
    }
  };
}
