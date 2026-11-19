// Runs the read-only collectors and turns what they observed into a snapshot.
//
// Disabled unless the settings say otherwise, and a live run needs exact host allowlists and credentials in the
// environment. One vendor failing does not hide the others: the snapshot says which vendors were read and which failed.
// NOT TESTED AGAINST A REAL SYSTEM.

import { createGuardedHttp } from "../live/guarded-http.mjs";
import { buildSnapshot } from "../snapshot.mjs";
import { COLLECTORS } from "./adapters.mjs";
import { readOnly } from "./readonly-http.mjs";

export const COLLECTOR_REFUSALS = ["collector_disabled", "untested_not_acknowledged", "no_vendors_configured", "host_allowlist_missing"];

const merge = (parts) => {
  const out = {};
  for (const part of parts) for (const [vendor, section] of Object.entries(part)) out[vendor] = { ...(out[vendor] ?? {}), ...section };
  return out;
};

/**
 * @param {object} options
 * @param {object} options.settings { enabled, acknowledgesUntested, vendors: { cloudflare: { zoneId, recordName, hosts }, ... } }
 * @param {object} options.env credentials
 * @param {typeof fetch} options.fetchImpl
 * @param {Date} options.now
 * @param {string} options.snapshotId
 */
export async function collectSnapshot({ settings, env, fetchImpl, now, snapshotId }) {
  if (settings?.enabled !== true) return { ok: false, refusal: "collector_disabled" };
  if (settings.acknowledgesUntested !== true) return { ok: false, refusal: "untested_not_acknowledged" };
  const names = Object.keys(settings.vendors ?? {}).filter((v) => COLLECTORS[v]);
  if (names.length === 0) return { ok: false, refusal: "no_vendors_configured" };
  if (names.some((v) => !Array.isArray(settings.vendors[v].hosts) || settings.vendors[v].hosts.length === 0)) return { ok: false, refusal: "host_allowlist_missing" };

  const read = [];
  const failed = [];
  const parts = [];
  for (const vendor of names.sort()) {
    const conf = settings.vendors[vendor];
    try {
      const http = readOnly(createGuardedHttp({ allowedHosts: conf.hosts, fetchImpl }));
      parts.push(await COLLECTORS[vendor].collect({ http, settings: conf, env }));
      read.push({ vendor, level: COLLECTORS[vendor].level, mode: "read-only" });
    } catch (error) {
      // The code is enough to act on. A message could carry response text.
      failed.push({ vendor, reason: error?.code ?? "unexpected_response" });
    }
  }
  if (read.length === 0) return { ok: false, refusal: "all_vendors_failed", failed };
  const observed = merge(parts);
  const snapshot = await buildSnapshot(observed, {
    snapshotId, capturedAt: now.toISOString().replace(/\.\d+Z$/, "Z"), label: `Collected from ${read.map((r) => r.vendor).join(", ")}${failed.length ? ` (${failed.length} failed)` : ""}`,
    synthetic: settings.synthetic === true,
    source: { kind: "live-collector", access: read, plannedAccess: [], ...(failed.length ? { failed } : {}) }
  });
  return { ok: true, snapshot, failed };
}
