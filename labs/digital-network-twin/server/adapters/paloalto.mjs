// Palo Alto write adapter: address objects, with an explicit commit. NOT TESTED AGAINST A REAL SYSTEM.
//
// PAN-OS keeps a candidate configuration and a running one. The REST API edits the candidate; only a commit (XML
// API) changes what the firewall enforces. This adapter treats them as different steps and shows both in the plan:
//   1. refuse if the candidate already has pending changes, because a commit could not exclude them,
//   2. edit the candidate through REST,
//   3. check the pending list holds only this object,
//   4. commit a partial commit limited to the API administrator, and take the job id,
//   5. poll the job to completion: an enqueued job is not success,
//   6. read the running configuration back and compare it with the plan.
// A failure after step 2 leaves the candidate as it is and says so; undoing it is a separately authorized change.

import { secretFromEnv } from "../../tools/live/credentials.mjs";
import { guardedWrite, WriteError } from "./common.mjs";
import { CHANGE_TYPES, planObject } from "./paloalto-plan.mjs";
export { CHANGE_TYPES, planObject };

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/** Narrow XML reading: one tag's text, all members of a list. No general parser, so nothing to exploit. */
export const xmlText = (xml, tag) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`))?.[1] ?? null;
export const xmlMembers = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const xmlOk = (xml) => /<response[^>]*\sstatus="success"/.test(xml);
const xmlEscape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

export function createPaloAltoAdapter({ http, target, env, sleep = sleepDefault, pollMs = 3000, maxPolls = 40 }) {
  const key = () => ({ "x-pan-key": secretFromEnv(env, target.credentialEnv).reveal() });
  const rest = `https://${target.host}/restapi/v11.0/Objects/Addresses`;
  const q = (name) => `location=vsys&vsys=${encodeURIComponent(target.vsys)}${name ? `&name=${encodeURIComponent(name)}` : ""}`;
  const xmlApi = (params) => http({ method: "GET", url: `https://${target.host}/api/?${new URLSearchParams(params)}`, auth: key, expect: "xml" });
  const xpath = (name) => `/config/devices/entry[@name='${target.deviceName}']/vsys/entry[@name='${target.vsys}']/address/entry[@name='${name}']`;

  async function pendingList() {
    const r = await xmlApi({ type: "op", cmd: "<show><config><list><changes/></list></config></show>" });
    if (r.status !== 200 || !xmlOk(r.text) || !/<result/.test(r.text)) throw new WriteError("pending_changes_unreadable", r.status);
    return xmlMembers(r.text, "member");
  }

  async function candidateObject(name) {
    const r = await http({ method: "GET", url: `${rest}?${q(name)}`, auth: key });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new WriteError("read_failed", r.status);
    const e = r.json?.result?.entry?.[0];
    if (!e) return null;
    return { name: String(e["@name"]), ipNetmask: String(e["ip-netmask"] ?? ""), description: String(e.description ?? "") };
  }

  async function runningObject(name) {
    const r = await xmlApi({ type: "config", action: "show", xpath: xpath(name) });
    if (r.status !== 200 || !xmlOk(r.text)) throw new WriteError("running_read_failed", r.status);
    if (!/<entry\s/.test(r.text)) return null;
    return { name, ipNetmask: xmlText(r.text, "ip-netmask") ?? "", description: xmlText(r.text, "description") ?? "" };
  }

  return {
    vendor: "paloalto",
    changeTypes: CHANGE_TYPES,
    async readState({ params }) { return { object: await candidateObject(params.name), pending: (await pendingList()).length }; },
    async plan({ changeType, params, opId }) {
      const state = { object: await candidateObject(params.name), pending: (await pendingList()).length };
      return { baseline: state, ...planObject({ changeType, params, state, opId, target }) };
    },

    async execute(plan, { params, changeType }) {
      const name = params.name;
      const creating = changeType === "address-object.create";
      const o = plan.proposed.object;
      // Step 2: the candidate edit.
      const write = async () => {
        const r = creating
          ? await http({ method: "POST", url: `${rest}?${q(name)}`, auth: key, body: { entry: { "@name": o.name, "ip-netmask": o.ipNetmask, description: o.description } } })
          : await http({ method: "DELETE", url: `${rest}?${q(name)}`, auth: key });
        if (r.status >= 400) throw new WriteError("write_refused", r.status);
      };
      const candidate = await guardedWrite({ write, read: async () => ({ object: await candidateObject(name), pending: (await pendingList()).length }), baseline: plan.baseline, proposed: { ...plan.proposed, pending: plan.baseline.pending + 1 } });
      if (candidate.outcome !== "verified") return { ...candidate, stage: "candidate", candidateLeftInPlace: candidate.outcome === "uncertain" };

      // Step 3: only this object may be pending.
      let pending;
      try { pending = await pendingList(); } catch { return { outcome: "uncertain", reason: "pending_changes_unreadable", stage: "pre-commit", candidateLeftInPlace: true }; }
      if (pending.length === 0 || pending.some((m) => !m.includes(`'${name}'`))) return { outcome: "failed", reason: "unrelated_pending_changes_cannot_be_excluded", stage: "pre-commit", candidateLeftInPlace: true };

      // Step 4: the commit, limited to the API administrator.
      let jobId = null;
      try {
        const cmd = `<commit><partial><admin><member>${xmlEscape(target.commitAdmin)}</member></admin></partial></commit>`;
        const r = await xmlApi({ type: "commit", cmd });
        if (r.status !== 200 || !xmlOk(r.text)) return { outcome: "failed", reason: "commit_refused", stage: "commit", candidateLeftInPlace: true };
        jobId = xmlText(r.text, "job");
      } catch (error) {
        // The commit may or may not have been queued. Check the running configuration; do not queue another.
        try {
          const running = await runningObject(name);
          if (creating ? running !== null && running.ipNetmask === o.ipNetmask && running.description === o.description : running === null) return { outcome: "verified", note: "commit_response_lost_running_verified", stage: "commit" };
        } catch { /* fall through */ }
        return { outcome: "uncertain", reason: "commit_response_lost", stage: "commit", candidateLeftInPlace: true };
      }
      if (!jobId || !/^\d+$/.test(jobId)) return { outcome: "uncertain", reason: "commit_job_id_missing", stage: "commit", candidateLeftInPlace: true };

      // Step 5: poll to completion. Queued and active are not success.
      let result = null;
      for (let i = 0; i < maxPolls; i += 1) {
        try {
          const r = await xmlApi({ type: "op", cmd: `<show><jobs><id>${jobId}</id></jobs></show>` });
          if (xmlText(r.text, "status") === "FIN") { result = xmlText(r.text, "result"); break; }
        } catch { /* keep polling; a lost poll is not a failure */ }
        await sleep(pollMs);
      }
      if (result === null) return { outcome: "uncertain", reason: "commit_job_not_finished", stage: "commit", jobId };
      if (result !== "OK") return { outcome: "failed", reason: `commit_job_${String(result).toLowerCase().replace(/[^a-z]/g, "").slice(0, 20)}`, stage: "commit", jobId, candidateLeftInPlace: true };

      // Step 6: the running configuration, not the candidate.
      let running;
      try { running = await runningObject(name); } catch { return { outcome: "uncertain", reason: "running_unreadable_after_commit", stage: "verify", jobId }; }
      const ok = creating ? running !== null && running.ipNetmask === o.ipNetmask && running.description === o.description : running === null;
      return ok ? { outcome: "verified", stage: "verify", jobId } : { outcome: "uncertain", reason: "running_differs_after_commit", stage: "verify", jobId };
    }
  };
}
