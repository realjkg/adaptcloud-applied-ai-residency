// Simulated vendors for the same write workflow. They run the same planners as the live adapters, on in-memory state,
// and can inject the failures the workflow must survive. No network, no credentials. This is what learner deployments
// use, and it includes an SD-WAN change type that has no live adapter.

import { guardedWrite, listDiff, markFor, same, WriteError } from "./common.mjs";
import { CHANGE_TYPES as MX, planRules } from "./meraki-plan.mjs";
import { CHANGE_TYPES as PA, planObject } from "./paloalto-plan.mjs";

const clone = (v) => structuredClone(v);

export const SDWAN_CHANGE_TYPES = {
  "sdwan.uplink-preference.set": {
    label: "Set the preferred uplink for a traffic class (simulated only)",
    fields: [{ name: "trafficClass", label: "Traffic class" }, { name: "preferredUplink", label: "Preferred uplink", options: ["wan1", "wan2"] }],
    validate(p) {
      const bad = [];
      if (typeof p.trafficClass !== "string" || !/^[a-z0-9-]{1,32}$/.test(p.trafficClass)) bad.push("trafficClass must be lowercase letters, digits, or -");
      if (!["wan1", "wan2"].includes(p.preferredUplink)) bad.push("preferredUplink must be wan1 or wan2");
      return bad;
    },
    inverse: (p, { before }) => (before === undefined ? null : { changeType: "sdwan.uplink-preference.set", params: { trafficClass: p.trafficClass, preferredUplink: before } })
  }
};

export function createSimulatedAdapters() {
  const sim = {
    pan: { object: new Map(), pending: 0, running: new Map() },
    mx: { rules: [] },
    sdwan: { prefs: { "voice": "wan1", "video": "wan1" } },
    // Failure injection for tests: "lost" applies the write but loses the reply; "dropped" loses the write and the reply.
    nextWrite: null,
    foreignEdit: null,
    writes: 0
  };

  const paloalto = {
    vendor: "paloalto",
    changeTypes: PA,
    async readState({ params }) { return { object: clone(sim.pan.object.get(params.name) ?? null), pending: sim.pan.pending }; },
    async plan({ changeType, params, opId, target }) {
      const state = await this.readState({ params });
      return { baseline: state, ...planObject({ changeType, params, state, opId, target }) };
    },
    async execute(plan, { params, changeType }) {
      const name = params.name;
      const creating = changeType === "address-object.create";
      const planned = sim.nextWrite; sim.nextWrite = null;
      let first = true;
      const write = async () => {
        // Injected failures apply to the first attempt only, as a transient fault would.
        const mode = first ? planned : null; first = false;
        if (mode === "refuse") throw new WriteError("write_refused", 400);
        if (mode !== "dropped") { sim.writes += 1; if (creating) sim.pan.object.set(name, clone(plan.proposed.object)); else sim.pan.object.delete(name); sim.pan.pending += 1; }
        if (mode === "lost" || mode === "dropped") throw new WriteError("transport_error");
      };
      const read = async () => ({ object: clone(sim.pan.object.get(name) ?? null), pending: sim.pan.pending });
      const cand = await guardedWrite({ write, read, baseline: plan.baseline, proposed: { ...plan.proposed, pending: plan.baseline.pending + 1 } });
      if (cand.outcome !== "verified") return { ...cand, stage: "candidate", candidateLeftInPlace: cand.outcome === "uncertain" };
      if (sim.foreignEdit === "pending") return { outcome: "failed", reason: "unrelated_pending_changes_cannot_be_excluded", stage: "pre-commit", candidateLeftInPlace: true };
      const mode = planned;
      if (mode === "commit-stuck") return { outcome: "uncertain", reason: "commit_job_not_finished", stage: "commit", jobId: "1" };
      if (mode === "commit-fail") return { outcome: "failed", reason: "commit_job_fail", stage: "commit", jobId: "1", candidateLeftInPlace: true };
      // Commit: candidate becomes running, and pending clears.
      for (const [k, v] of sim.pan.object) sim.pan.running.set(k, clone(v));
      for (const k of [...sim.pan.running.keys()]) if (!sim.pan.object.has(k)) sim.pan.running.delete(k);
      sim.pan.pending = 0;
      const running = sim.pan.running.get(name) ?? null;
      const ok = creating ? running !== null && same(running, plan.proposed.object) : running === null;
      return ok ? { outcome: "verified", stage: "verify", jobId: "1" } : { outcome: "uncertain", reason: "running_differs_after_commit", stage: "verify" };
    }
  };

  const meraki = {
    vendor: "meraki",
    changeTypes: { ...MX, ...SDWAN_CHANGE_TYPES },
    async readState({ changeType }) {
      if (changeType.startsWith("sdwan.")) return { prefs: clone(sim.sdwan.prefs) };
      return { rules: clone(sim.mx.rules) };
    },
    async plan({ changeType, params, opId }) {
      const state = await this.readState({ changeType });
      if (changeType.startsWith("sdwan.")) {
        const proposed = { prefs: { ...state.prefs, [params.trafficClass]: params.preferredUplink } };
        const render = (p) => Object.entries(p).sort().map(([k, v]) => `${k} -> ${v}`);
        return { baseline: state, proposed, blockers: state.prefs[params.trafficClass] === params.preferredUplink ? ["no_change"] : [], diff: { ...listDiff(render(state.prefs), render(proposed.prefs), (x) => x), unrelatedRulesUnchanged: true }, requiresExclusiveWindow: true, commitScope: null, previousValue: state.prefs[params.trafficClass] };
      }
      return { baseline: state, ...planRules({ changeType, params, state, opId }) };
    },
    async execute(plan, { changeType }) {
      const sd = changeType.startsWith("sdwan.");
      const planned = sim.nextWrite; sim.nextWrite = null;
      let first = true;
      const write = async () => {
        // Injected failures apply to the first attempt only, as a transient fault would.
        const mode = first ? planned : null; first = false;
        if (mode === "refuse") throw new WriteError("write_refused", 400);
        if (mode !== "dropped") { sim.writes += 1; if (sd) sim.sdwan.prefs = clone(plan.proposed.prefs); else sim.mx.rules = clone(plan.proposed.rules); }
        if (mode === "lost" || mode === "dropped") throw new WriteError("transport_error");
      };
      const read = async () => (sd ? { prefs: clone(sim.sdwan.prefs) } : { rules: clone(sim.mx.rules) });
      return guardedWrite({ write, read, baseline: plan.baseline, proposed: plan.proposed });
    }
  };
  void markFor;
  return { sim, adapters: { paloalto, meraki } };
}
