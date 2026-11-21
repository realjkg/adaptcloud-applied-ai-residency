// Cloudflare edge write adapter: Rulesets API, one zone. NOT TESTED AGAINST A REAL ZONE.
//
// Request shapes follow the Cloudflare Rulesets documentation as read through the Cloudflare documentation connector: an
// entry point ruleset per phase (GET .../rulesets/phases/{phase}/entrypoint, 404 when the phase has none), a single rule added
// with POST .../rulesets/{id}/rules (appended; the reply is the whole ruleset; the ruleset version increments), a rule deleted
// with DELETE .../rulesets/{id}/rules/{rule id}, and, when the entry point does not exist, one POST .../rulesets that creates
// it with the rule inside.
//
// A single-rule add or delete never rewrites other rules, so another administrator's rules cannot be overwritten. What a
// fresh read cannot prevent is a concurrent edit during the write, so the read-back compares the rules and reports a
// mismatch as uncertain, without repair.

import { secretFromEnv } from "../../tools/live/credentials.mjs";
import { normalizeTarget } from "../target-resolution.mjs";
import { guardedWrite, WriteError } from "./common.mjs";
import { CHANGE_TYPES, compact, normalizeRule, PHASES, planEdge } from "./cloudflare-plan.mjs";
export { CHANGE_TYPES, planEdge };

const ALL_PHASES = Object.values(PHASES);
const ZONE = /^[0-9a-f]{32}$/;

export function createCloudflareEdgeAdapter({ http, target: rawTarget, env }) {
  const target = normalizeTarget(rawTarget.id, rawTarget, "live");
  if (!ZONE.test(String(target.scope.zoneId))) throw new Error("cloudflare zoneId must be 32 hex characters");
  const auth = () => ({ authorization: `Bearer ${secretFromEnv(env, target.credentialEnv).reveal()}` });
  const base = `https://${target.host}/client/v4/zones/${target.scope.zoneId}`;
  const ok = (r) => r.status >= 200 && r.status < 300 && r.json?.success !== false;

  /** The entry point ruleset for a phase, as the full internal state. Ids are kept for deletes and left out of comparisons. */
  async function readPhase(phase) {
    const r = await http({ method: "GET", url: `${base}/rulesets/phases/${phase}/entrypoint`, auth });
    if (r.status === 404) return { exists: false, rulesetId: null, version: 0, rules: [] };
    if (!ok(r) || !Array.isArray(r.json?.result?.rules ?? [])) throw new WriteError("read_failed", r.status);
    const res = r.json.result;
    return { exists: true, rulesetId: String(res.id), version: Number(res.version) || 0, rules: (res.rules ?? []).map((x) => ({ id: String(x.id), ...normalizeRule(x) })) };
  }

  return {
    vendor: "cloudflare",
    changeTypes: CHANGE_TYPES,
    /** The zone must be the inventoried one: same name, same account. */
    async verifyScope() {
      const r = await http({ method: "GET", url: base, auth });
      if (r.status === 401 || r.status === 403) throw new WriteError("token_rejected", r.status);
      if (!ok(r) || r.json?.result?.name !== target.scope.zoneName || r.json?.result?.account?.id !== target.scope.accountId) throw new WriteError("device_does_not_match_inventory");
    },
    /** Read-only preflight: identity, and that every supported phase reads with the expected shape. */
    async preflight() {
      const checks = [];
      const run = async (name, fn) => { try { await fn(); checks.push({ name, pass: true }); } catch (error) { checks.push({ name, pass: false, detail: String(error?.code ?? error?.message ?? "failed").slice(0, 60) }); } };
      await run("zone matches inventory (name and account)", () => this.verifyScope());
      for (const phase of ALL_PHASES) await run(`${phase} entry point reads with the expected shape`, () => readPhase(phase));
      return { checks, notExercised: ["rule add reply", "rule delete reply", "entry point creation reply"] };
    },
    async readState({ changeType, params }) {
      const phase = changeType === "edge-rule.remove" ? params.phase : PHASES[changeType.split(".")[0]];
      return readPhase(phase);
    },
    async plan({ changeType, params, opId }) {
      const phase = changeType === "edge-rule.remove" ? params.phase : PHASES[changeType.split(".")[0]];
      const state = await readPhase(phase);
      return { baseline: state, ...planEdge({ changeType, params, state, opId }) };
    },
    async execute(plan, { changeType, params }) {
      const phase = plan.phase;
      const adding = changeType !== "edge-rule.remove";
      const newRule = adding ? plan.proposed.rules.at(-1) : null;
      const write = async () => {
        let r;
        if (adding && plan.baseline.exists) r = await http({ method: "POST", url: `${base}/rulesets/${plan.baseline.rulesetId}/rules`, auth, body: newRule });
        else if (adding) r = await http({ method: "POST", url: `${base}/rulesets`, auth, body: { name: `Phase entry point for ${phase}`, kind: "zone", phase, rules: [newRule] } });
        else {
          const hit = plan.baseline.rules.find((x) => x.ref === `twin-${params.mark.toLowerCase()}`);
          if (!hit) throw new WriteError("rule_not_found", 404);
          r = await http({ method: "DELETE", url: `${base}/rulesets/${plan.baseline.rulesetId}/rules/${hit.id}`, auth });
        }
        if (r.status >= 400 || r.json?.success === false) throw new WriteError("write_refused", r.status >= 400 ? r.status : 400);
      };
      const read = async () => compact(await readPhase(phase));
      const result = await guardedWrite({ write, read, baseline: compact(plan.baseline), proposed: plan.proposed });
      return result;
    }
  };
}
