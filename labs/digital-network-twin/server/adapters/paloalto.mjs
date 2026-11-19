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
import { normalizeTarget } from "../target-resolution.mjs";
import { guardedWrite, isDefinitive, WriteError } from "./common.mjs";
import { CHANGE_TYPES, planObject } from "./paloalto-plan.mjs";
export { CHANGE_TYPES, planObject };

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/** Narrow XML reading: one tag's text, all members of a list. No general parser, so nothing to exploit. */
export const xmlText = (xml, tag) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`))?.[1] ?? null;
export const xmlMembers = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const xmlOk = (xml) => /<response[^>]*\sstatus="success"/.test(xml);
const xmlEscape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);


const JOB_ID = /^[1-9][0-9]{0,19}$/;
const ADMIN = /^[A-Za-z0-9_.@-]{1,128}$/;

/**
 * A PAN-OS reply must be a <response> with status success or error. An error is a definitive refusal. Anything else,
 * including an unreadable body, is an unknown outcome: on a write it must be reconciled, never replayed.
 */
export function panReply(text) {
  if (typeof text !== "string" || !/^\s*(<\?xml[^>]*\?>\s*)?<response\b/.test(text)) throw new WriteError("pan_unexpected_response");
  const status = /<response[^>]*\sstatus="(success|error)"/.exec(text)?.[1];
  if (!status) throw new WriteError("pan_unexpected_response");
  if (status === "error") throw new WriteError("pan_request_rejected", 400);
  return text;
}

export function createPaloAltoAdapter({ http, target: rawTarget, env, sleep = sleepDefault, pollMs = 3000, maxPolls = 40 }) {
  const target = normalizeTarget(rawTarget.id, rawTarget, "live");
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


  /**
   * Queues an administrator-scoped partial commit and returns the job id (null when PAN-OS reports nothing to commit).
   * Typed on purpose: callers pass an administrator name, never a command. A queued job is not an active configuration.
   * The shared-object and device-and-network sections are excluded, as in the documented partial commit.
   */
  async function submitPartialCommit(admin) {
    if (!ADMIN.test(String(admin))) throw new Error("invalid_pan_admin");
    const cmd = `<commit><partial><device-and-network>excluded</device-and-network><shared-object>excluded</shared-object><admin><member>${xmlEscape(admin)}</member></admin></partial></commit>`;
    const r = await xmlApi({ type: "commit", action: "partial", cmd });
    if (r.status >= 400 && r.status < 500) throw new WriteError("commit_rejected", r.status);
    if (r.status >= 500) throw new WriteError("commit_outcome_unknown", r.status);
    const text = panReply(r.text);
    const job = xmlText(text, "job");
    if (job !== null && JOB_ID.test(job)) return { jobId: job };
    if (xmlText(text, "msg") === "There are no changes to commit.") return { jobId: null };
    throw new WriteError("pan_unexpected_response");
  }

  /** Reads one job's state. Read-only, so a failed lookup can simply be tried again. */
  async function readCommitJob(jobId) {
    if (!JOB_ID.test(String(jobId))) throw new Error("invalid_pan_job_id");
    const r = await xmlApi({ type: "op", cmd: `<show><jobs><id>${jobId}</id></jobs></show>` });
    const text = panReply(r.text);
    if (xmlText(text, "id") !== String(jobId)) throw new WriteError("pan_job_not_confirmed");
    const status = xmlText(text, "status");
    const result = xmlText(text, "result");
    if (!status || !result) throw new WriteError("pan_job_not_confirmed");
    return { status, result };
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
    submitPartialCommit, readCommitJob,
    /** Settles a known commit job without submitting anything: one job lookup, then the running-config read-back. */
    async finishFromJob(plan, { params, changeType, jobId }) {
      const name = params.name;
      const creating = changeType === "address-object.create";
      const o = plan.proposed.object;
      const job = await readCommitJob(jobId);
      if (job.status !== "FIN") return { outcome: "uncertain", reason: "commit_job_not_finished", stage: "commit", jobId };
      if (job.result !== "OK") return { outcome: "failed", reason: `commit_job_${String(job.result).toLowerCase().replace(/[^a-z]/g, "").slice(0, 20)}`, stage: "commit", jobId, candidateLeftInPlace: true };
      const running = await runningObject(name);
      const ok = creating ? running !== null && running.ipNetmask === o.ipNetmask && running.description === o.description : running === null;
      return ok ? { outcome: "verified", stage: "verify", jobId } : { outcome: "uncertain", reason: "running_differs_after_commit", stage: "verify", jobId };
    },
    /** The device that answers must be the one in inventory, checked before anything is staged. */
    async verifyScope() {
      const expected = target.scope?.firewallSerial;
      if (!expected) throw new WriteError("scope_serial_missing");
      const r = await xmlApi({ type: "op", cmd: "<show><system><info/></system></show>" });
      const text = panReply(r.text);
      if (xmlText(text, "serial") !== expected) throw new WriteError("device_does_not_match_inventory");
    },
    async readState({ params }) { return { object: await candidateObject(params.name), pending: (await pendingList()).length }; },
    async plan({ changeType, params, opId }) {
      const state = { object: await candidateObject(params.name), pending: (await pendingList()).length };
      return { baseline: state, ...planObject({ changeType, params, state, opId, target }) };
    },

    async execute(plan, ctx) {
      const { params, changeType } = ctx;
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

      // Step 4: the commit, limited to the API administrator. The intent is made durable first and can be recorded only once,
      // so a retry or a restart can never submit a second commit for this operation. A reply that cannot be read is never
      // answered by sending it again.
      if (ctx.recordCommitIntent) {
        try { await ctx.recordCommitIntent(); } catch (error) {
          return error?.code === "EEXIST" || error?.message === "commit_intent_already_attempted"
            ? { outcome: "uncertain", reason: "commit_intent_already_recorded", stage: "commit", candidateLeftInPlace: true }
            : { outcome: "failed", reason: "commit_intent_not_recorded", stage: "commit", candidateLeftInPlace: true };
        }
      }
      let jobId = null;
      try {
        ({ jobId } = await submitPartialCommit(target.commitAdmin));
      } catch (error) {
        if (isDefinitive(error)) return { outcome: "failed", reason: "commit_refused", stage: "commit", candidateLeftInPlace: true };
        // The commit may or may not have been queued. Reconcile against the running configuration; do not queue another.
        try {
          const running = await runningObject(name);
          if (creating ? running !== null && running.ipNetmask === o.ipNetmask && running.description === o.description : running === null) return { outcome: "verified", note: "commit_response_lost_running_verified", stage: "commit" };
        } catch { /* fall through */ }
        return { outcome: "uncertain", reason: "commit_response_lost", stage: "commit", candidateLeftInPlace: true };
      }

      // Step 5: persist the job id before polling, then poll to completion. Queued and active are not success.
      // No job means PAN-OS reported nothing to commit; the read-back below still decides the outcome.
      if (jobId !== null) {
        // The commit was accepted. If its job id cannot be made durable, stop here: nothing downstream may call this complete.
        try { await ctx.onJobQueued?.(jobId); } catch { return { outcome: "uncertain", reason: "commit_job_not_recorded", stage: "commit", jobId, candidateLeftInPlace: true }; }
        let result = null;
        for (let i = 0; i < maxPolls; i += 1) {
          try {
            const job = await readCommitJob(jobId);
            if (job.status === "FIN") { result = job.result; break; }
          } catch { /* keep polling; a lost poll is not a failure */ }
          await sleep(pollMs);
        }
        if (result === null) return { outcome: "uncertain", reason: "commit_job_not_finished", stage: "commit", jobId };
        if (result !== "OK") return { outcome: "failed", reason: `commit_job_${String(result).toLowerCase().replace(/[^a-z]/g, "").slice(0, 20)}`, stage: "commit", jobId, candidateLeftInPlace: true };
      }

      // Step 6: the running configuration, not the candidate.
      let running;
      try { running = await runningObject(name); } catch { return { outcome: "uncertain", reason: "running_unreadable_after_commit", stage: "verify", jobId }; }
      const ok = creating ? running !== null && running.ipNetmask === o.ipNetmask && running.description === o.description : running === null;
      return ok ? { outcome: "verified", stage: "verify", ...(jobId ? { jobId } : { note: "no_changes_to_commit_running_verified" }) } : { outcome: "uncertain", reason: "running_differs_after_commit", stage: "verify", jobId };
    }
  };
}
