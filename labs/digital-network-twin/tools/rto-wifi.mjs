#!/usr/bin/env node
// Return-to-office Wi-Fi capacity what-if.
//
// Question it answers: if more people are in the office more days a week, what happens to the Wi-Fi, the address
// pool, and the site uplink, and how many users sit on the part that breaks first?
//
// This is capacity arithmetic, not RF simulation. It follows Cisco Meraki's published sizing method (aggregate
// throughput divided by per-AP throughput, and concurrent 5 GHz clients divided by about 25 per radio, taking the
// larger AP count). It cannot see coverage, interference, roaming, or channel planning. Treat its output as a
// reason to look closely, then validate against a site survey and dashboard data. See docs/RTO_WIFI_SCENARIO.md.
//
// Every parameter carries a provenance tag, so nobody mistakes a placeholder for a measurement.

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCENARIO = join(HERE, "..", "scenarios", "rto-wifi.json");

export const PROVENANCE = ["meraki-doc", "placeholder", "client-input-needed", "client-provided"];

/** Every scalar parameter, by path. Each must have a provenance entry in the scenario. */
export const PARAM_PATHS = [
  "population.returningStaff", "population.existingOnSiteStaff", "population.daysPerWeekBefore", "population.daysPerWeekAfter",
  "population.workDaysPerWeek", "population.peakDayFactor",
  "clients.devicesPerUser", "clients.fiveGhzShare", "clients.activeShare",
  "traffic.perUserMbps",
  "radio.channelWidthMHz", "radio.perApThroughputMbps", "radio.recommendedClientsPerRadio", "radio.highDensityThresholdPerAp", "radio.apUplinkMbps",
  "limits.targetUtilization", "limits.watchFraction",
  "network.corpVlanPrefix", "network.reservedAddresses", "network.leaseCarryover", "network.wanUplinkMbps", "network.wanShare",
  "zones"
];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const get = (obj, path) => path.split(".").reduce((o, k) => (isObject(o) ? o[k] : undefined), obj);

/** Returns a list of problems. Messages name fields and never echo values, so untrusted text cannot reach output. */
export function validateScenario(s) {
  const problems = [];
  if (!isObject(s)) return ["scenario must be a JSON object"];
  const need = (path, min, max, integer = false) => {
    const v = get(s, path);
    if (!inRange(v, min, max) || (integer && !Number.isInteger(v))) problems.push(`${path} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  };
  if (typeof s.synthetic !== "boolean") problems.push("synthetic must be true or false");
  need("population.returningStaff", 0, 100000, true);
  need("population.existingOnSiteStaff", 0, 100000, true);
  need("population.workDaysPerWeek", 1, 7, true);
  need("population.peakDayFactor", 1, 3);
  const work = get(s, "population.workDaysPerWeek");
  const maxDays = Number.isInteger(work) ? work : 7;
  need("population.daysPerWeekBefore", 0, maxDays);
  need("population.daysPerWeekAfter", 0, maxDays);
  need("clients.devicesPerUser", 1, 10);
  need("clients.fiveGhzShare", 0, 1);
  need("clients.activeShare", 0, 1);
  need("traffic.perUserMbps", 0.01, 1000);
  need("radio.perApThroughputMbps", 1, 10000);
  need("radio.recommendedClientsPerRadio", 1, 512, true);
  need("radio.highDensityThresholdPerAp", 1, 1024, true);
  need("radio.apUplinkMbps", 100, 100000);
  if (![20, 40, 80, 160].includes(get(s, "radio.channelWidthMHz"))) problems.push("radio.channelWidthMHz must be 20, 40, 80, or 160");
  need("limits.targetUtilization", 0.1, 1);
  need("limits.watchFraction", 0.1, 1);
  need("network.corpVlanPrefix", 16, 30, true);
  need("network.reservedAddresses", 0, 1000, true);
  need("network.leaseCarryover", 0, 2);
  need("network.wanUplinkMbps", 10, 1000000);
  need("network.wanShare", 0, 1);

  const zones = s.zones;
  if (!Array.isArray(zones) || zones.length < 1 || zones.length > 50) {
    problems.push("zones must be a list of 1 to 50 entries");
  } else {
    const names = new Set();
    let total = 0;
    zones.forEach((zone, i) => {
      if (!isObject(zone) || typeof zone.name !== "string" || !/^[A-Za-z0-9 ._&-]{1,40}$/.test(zone.name)) problems.push(`zones[${i}].name must be 1 to 40 letters, digits, spaces, or . _ & -`);
      else if (names.has(zone.name)) problems.push(`zones[${i}].name is a duplicate`);
      else names.add(zone.name);
      if (!isObject(zone) || !inRange(zone.aps, 1, 1000) || !Number.isInteger(zone.aps)) problems.push(`zones[${i}].aps must be an integer from 1 to 1000`);
      if (!isObject(zone) || !inRange(zone.share, 0, 1)) problems.push(`zones[${i}].share must be a number from 0 to 1`);
      else total += zone.share;
    });
    if (Math.abs(total - 1) > 0.001) problems.push("zone shares must add up to 1");
  }

  const provenance = s.provenance;
  if (!isObject(provenance)) problems.push("provenance must be an object");
  else {
    for (const path of PARAM_PATHS) if (!PROVENANCE.includes(provenance[path])) problems.push(`provenance.${path} must be one of ${PROVENANCE.join(", ")}`);
  }
  return problems;
}

// Status ladder: over when value > limit, watch when value > watchAt, otherwise ok.
const rank = { ok: 0, watch: 1, over: 2 };
const worse = (a, b) => (rank[b] > rank[a] ? b : a);
const classify = (value, limit, watchAt) => (value > limit ? "over" : value > watchAt ? "watch" : "ok");
const round1 = (n) => Math.round(n * 10) / 10;

/** Smallest subnet (largest prefix length) whose usable addresses keep leased/usable at or under `ceiling`. */
export function recommendPrefix(leased, reserved, ceiling) {
  for (let prefix = 30; prefix >= 16; prefix -= 1) {
    const usable = 2 ** (32 - prefix) - 2 - reserved;
    if (usable > 0 && leased / usable <= ceiling) return prefix;
  }
  return null;
}

/** Evaluates the office at a given number of in-office days per week for the returning group. */
export function evaluate(s, days) {
  const { population: p, clients: c, traffic: t, radio: r, limits: l, network: n } = s;
  const peakOnSite = p.existingOnSiteStaff + p.returningStaff * (days / p.workDaysPerWeek) * p.peakDayFactor;
  const clientLimit = r.recommendedClientsPerRadio;

  const zones = s.zones.map((z) => {
    const users = peakOnSite * z.share;
    const associated = users * c.devicesPerUser;
    const associated5 = associated * c.fiveGhzShare;
    const perAp = associated / z.aps;
    const per5Radio = associated5 / z.aps;
    const demandMbps = users * c.activeShare * t.perUserMbps;
    const perApDemand = demandMbps / z.aps;
    const utilization = perApDemand / r.perApThroughputMbps;
    const uplinkUtilization = perApDemand / r.apUplinkMbps;

    const checks = [
      { metric: "5 GHz clients per radio", status: classify(per5Radio, clientLimit, clientLimit * l.watchFraction), text: `${round1(per5Radio)} per radio against about ${clientLimit}` },
      { metric: "AP throughput", status: classify(utilization, 1, l.targetUtilization), text: `${round1(utilization * 100)}% of ${r.perApThroughputMbps} Mbps per AP` },
      { metric: "AP uplink", status: classify(uplinkUtilization, 1, l.targetUtilization), text: `${round1(uplinkUtilization * 100)}% of ${r.apUplinkMbps} Mbps` }
    ];
    const status = checks.reduce((acc, check) => worse(acc, check.status), "ok");
    const apsMeraki = Math.max(Math.ceil(demandMbps / r.perApThroughputMbps), Math.ceil(associated5 / clientLimit), 1);
    const apsHeadroom = Math.max(Math.ceil(demandMbps / (r.perApThroughputMbps * l.targetUtilization)), Math.ceil(associated5 / (clientLimit * l.watchFraction)), 1);
    return {
      name: z.name, aps: z.aps, users, associated, perAp, per5Radio, demandMbps, perApDemand, utilization,
      highDensity: perAp > r.highDensityThresholdPerAp, status, checks,
      apsMeraki, apsHeadroom, addMinimum: Math.max(0, apsMeraki - z.aps), addWithHeadroom: Math.max(0, apsHeadroom - z.aps)
    };
  });

  const devices = peakOnSite * c.devicesPerUser;
  const leased = Math.ceil(devices * (1 + n.leaseCarryover));
  const usable = 2 ** (32 - n.corpVlanPrefix) - 2 - n.reservedAddresses;
  const dhcpUtil = leased / usable;
  const dhcp = {
    prefix: n.corpVlanPrefix, usable, leased, utilization: dhcpUtil, status: classify(dhcpUtil, 1, l.watchFraction),
    recommendedPrefix: recommendPrefix(leased, n.reservedAddresses, l.watchFraction)
  };

  const totalDemand = zones.reduce((sum, z) => sum + z.demandMbps, 0);
  const wanDemand = totalDemand * n.wanShare;
  const wan = { demandMbps: wanDemand, uplinkMbps: n.wanUplinkMbps, utilization: wanDemand / n.wanUplinkMbps, status: classify(wanDemand / n.wanUplinkMbps, 1, l.targetUtilization) };

  const impact = { ok: 0, watch: 0, over: 0 };
  for (const z of zones) impact[z.status] += z.users;
  const total = impact.ok + impact.watch + impact.over;
  const share = (n2) => (total === 0 ? 0 : n2 / total);

  return {
    days, peakOnSite, devices, zones, dhcp, wan,
    impact: { ok: share(impact.ok), watch: share(impact.watch), over: share(impact.over) },
    worst: [...zones.map((z) => z.status), dhcp.status, wan.status].reduce(worse, "ok")
  };
}

export function compare(s) {
  return { before: evaluate(s, s.population.daysPerWeekBefore), after: evaluate(s, s.population.daysPerWeekAfter) };
}

/** One row per whole day count, from 1 to workDaysPerWeek, to show where the first problem appears. */
export function sweep(s) {
  const rows = [];
  for (let d = 1; d <= s.population.workDaysPerWeek; d += 1) {
    const e = evaluate(s, d);
    rows.push({
      days: d, peakOnSite: e.peakOnSite, worstPer5Radio: Math.max(...e.zones.map((z) => z.per5Radio)),
      zonesWatch: e.zones.filter((z) => z.status === "watch").length, zonesOver: e.zones.filter((z) => z.status === "over").length,
      dhcpUtilization: e.dhcp.utilization, dhcpStatus: e.dhcp.status, wanUtilization: e.wan.utilization, wanStatus: e.wan.status,
      addMinimum: e.zones.reduce((sum, z) => sum + z.addMinimum, 0), addWithHeadroom: e.zones.reduce((sum, z) => sum + z.addWithHeadroom, 0),
      worst: e.worst
    });
  }
  return rows;
}

const pct = (n) => `${round1(n * 100)}%`;
const flag = { ok: "ok", watch: "WATCH", over: "OVER" };

export function renderReport(s) {
  const { before, after } = compare(s);
  const rows = sweep(s);
  const sources = { "meraki-doc": "Meraki documentation", placeholder: "placeholder", "client-input-needed": "needs client data", "client-provided": "client data" };
  const counts = {};
  for (const path of PARAM_PATHS) counts[s.provenance[path]] = (counts[s.provenance[path]] ?? 0) + 1;
  const { population: p } = s;

  const out = [];
  out.push(`# Return-to-office Wi-Fi what-if`);
  out.push("");
  out.push(`Scenario \`${s.scenarioId}\`. ${s.synthetic ? "**Synthetic inputs.** The numbers illustrate the mechanics and are not measurements of any real site." : "Inputs supplied for a real site. Keep this report out of the repository."}`);
  out.push("");
  out.push(`${p.returningStaff} people move from ${p.daysPerWeekBefore} to ${p.daysPerWeekAfter} days a week, on top of ${p.existingOnSiteStaff} people already on site. Peak-day factor ${p.peakDayFactor} (the busiest day is above the weekly average). Capacity arithmetic only: it does not model coverage, interference, or roaming.`);
  out.push("");
  out.push("## Before and after");
  out.push("");
  out.push(`| | Before (${before.days} d/wk) | After (${after.days} d/wk) |`);
  out.push("|---|---|---|");
  out.push(`| People on site, peak day | ${Math.round(before.peakOnSite)} | ${Math.round(after.peakOnSite)} |`);
  out.push(`| Devices associated | ${Math.round(before.devices)} | ${Math.round(after.devices)} |`);
  out.push(`| Users on a healthy zone | ${pct(before.impact.ok)} | ${pct(after.impact.ok)} |`);
  out.push(`| Users on a zone to watch | ${pct(before.impact.watch)} | ${pct(after.impact.watch)} |`);
  out.push(`| Users on an over-capacity zone | ${pct(before.impact.over)} | ${pct(after.impact.over)} |`);
  out.push(`| Corporate address pool (/${after.dhcp.prefix}) | ${pct(before.dhcp.utilization)} ${flag[before.dhcp.status]} | ${pct(after.dhcp.utilization)} ${flag[after.dhcp.status]} |`);
  out.push(`| Site uplink (${after.wan.uplinkMbps} Mbps) | ${pct(before.wan.utilization)} ${flag[before.wan.status]} | ${pct(after.wan.utilization)} ${flag[after.wan.status]} |`);
  out.push("");
  out.push("## Zones");
  out.push("");
  out.push("| Zone | APs | 5 GHz clients per radio, before | after | Status after | First limit reached | Add (Meraki method) | Add (with headroom) |");
  out.push("|---|---|---|---|---|---|---|---|");
  after.zones.forEach((z, i) => {
    const b = before.zones[i];
    const first = z.checks.filter((c) => c.status !== "ok").map((c) => `${c.metric}: ${c.text}`).join("; ") || "none";
    out.push(`| ${z.name} | ${z.aps} | ${round1(b.per5Radio)} ${flag[b.status]} | ${round1(z.per5Radio)} | ${flag[z.status]} | ${first} | +${z.addMinimum} | +${z.addWithHeadroom} |`);
  });
  const sumMin = after.zones.reduce((a, z) => a + z.addMinimum, 0);
  const sumHead = after.zones.reduce((a, z) => a + z.addWithHeadroom, 0);
  out.push("");
  out.push(`Access points to add: **${sumMin}** by the Meraki method (${s.radio.recommendedClientsPerRadio} 5 GHz clients per radio), **${sumHead}** to keep every zone under its watch level.`);
  if (after.dhcp.status !== "ok") out.push(`Address pool: ${after.dhcp.leased} leases against ${after.dhcp.usable} usable addresses${after.dhcp.recommendedPrefix ? `. A /${after.dhcp.recommendedPrefix} keeps it under ${pct(s.limits.watchFraction)}.` : ". No subnet down to /16 keeps it under the watch level."}`);
  out.push("");
  out.push("## Where the problem starts");
  out.push("");
  out.push("| Days a week | People on site | Worst 5 GHz clients per radio | Zones to watch | Zones over | Address pool | Uplink | Add APs (min / headroom) |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.days} | ${Math.round(r.peakOnSite)} | ${round1(r.worstPer5Radio)} | ${r.zonesWatch} | ${r.zonesOver} | ${pct(r.dhcpUtilization)} ${flag[r.dhcpStatus]} | ${pct(r.wanUtilization)} ${flag[r.wanStatus]} | ${r.addMinimum} / ${r.addWithHeadroom} |`);
  out.push("");
  out.push("## Parameters and where each came from");
  out.push("");
  out.push(`${Object.entries(counts).map(([k, v]) => `${v} ${sources[k]}`).join(", ")}.`);
  out.push("");
  out.push("| Parameter | Value | Source |");
  out.push("|---|---|---|");
  for (const path of PARAM_PATHS.filter((x) => x !== "zones")) out.push(`| \`${path}\` | ${get(s, path)} | ${sources[s.provenance[path]]} |`);
  out.push(`| \`zones\` | ${s.zones.map((z) => `${z.name}: ${z.aps} APs, ${pct(z.share)} of staff`).join("; ")} | ${sources[s.provenance.zones]} |`);
  out.push("");
  out.push("Anything marked placeholder or needs client data must be replaced before the result is shown as a prediction.");
  return `${out.join("\n")}\n`;
}

export async function main(argv) {
  const flagValue = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const path = flagValue("--scenario") ?? DEFAULT_SCENARIO;
  let scenario;
  try {
    scenario = JSON.parse(await readFile(path, "utf8"));
  } catch {
    console.error("could not read the scenario as JSON");
    return 2;
  }
  const problems = validateScenario(scenario);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`invalid: ${problem}`);
    return 2;
  }
  // Real client numbers stay out of the repository: a non-synthetic scenario is accepted only from a *.client.json file.
  if (scenario.synthetic !== true && !basename(path).endsWith(".client.json")) {
    console.error("a scenario with real data must be in a file named *.client.json, which is ignored by git");
    return 2;
  }
  if (scenario.synthetic !== true && flagValue("--out")) {
    console.error("refusing to write a report for real data; print it instead");
    return 2;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...compare(scenario), sweep: sweep(scenario) }, null, 2));
  } else {
    const report = renderReport(scenario);
    if (flagValue("--out")) {
      await writeFile(flagValue("--out"), report);
      console.log(`wrote ${flagValue("--out")}`);
    } else console.log(report);
  }
  return argv.includes("--fail-on-over") && compare(scenario).after.worst === "over" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
