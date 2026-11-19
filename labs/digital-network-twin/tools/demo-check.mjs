#!/usr/bin/env node
// Pre-flight for the working session. Runs every step the runbook (docs/WORKING_SESSION.md) claims, offline, and
// fails if any of them no longer behaves as described. Run it before the call.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluate, renderReport as renderAsBuilt } from "./asbuilt.mjs";
import { runAgent } from "./health-agent.mjs";
import { runRoundtrip } from "./provision-cli.mjs";
import { buildChangeSet } from "./render-iac.mjs";
import { renderMarkdown, renderMermaid } from "./render-topology.mjs";
import { sweep } from "./rto-wifi.mjs";
import { loadStages } from "./twin-sequence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (...parts) => JSON.parse(readFileSync(join(HERE, "..", ...parts), "utf8"));
const demo = (name) => load("demo", `${name}.json`);

/** Returns [{ step, ok, detail }]. Pure apart from reading files. */
export async function runDemoChecks() {
  const stages = loadStages();
  const reference = load("config", "twin-config.json");
  const results = [];
  const check = (step, ok, detail) => results.push({ step, ok: Boolean(ok), detail });

  // Step 1: one source of truth, drawn as a topology, with the committed doc exactly what the model produces.
  const fullText = renderMermaid(reference);
  check("1  the reference twin draws every vendor", ["Cloudflare edge", "Palo Alto NGFW", "F5 virtual server", "Meraki MX", "Panorama"].every((t) => fullText.includes(t)), "topology contains all five components");
  check("1  the committed topology doc is current", readFileSync(join(HERE, "..", "docs", "TOPOLOGY.md"), "utf8") === renderMarkdown(reference), "docs/TOPOLOGY.md equals the rendered output");

  // Step 2: a change shows up in the picture, so the picture cannot go stale unnoticed.
  const riskyText = renderMermaid(demo("proposed-change-risky"));
  check("2  a proposed rule changes the diagram", riskyText !== fullText && /linkStyle \d+ stroke:#d33/.test(riskyText), "the risky change adds a red arrow");

  // Step 3: validation before the network. A safe change passes, a risky one halts at a named check.
  const safe = runAgent({ stages, config: demo("proposed-change-safe") });
  check("3  a safe change passes every check", safe.status === "healthy" && safe.through === "12", "healthy through stage 12");
  const risky = runAgent({ stages, config: demo("proposed-change-risky") });
  check("3  a risky change halts at a named check", risky.status === "halted" && risky.halted.stage === "11" && risky.halted.failing.includes("HC-11-ISOLATION"), `halted at stage ${risky.halted?.stage} on ${risky.halted?.failing?.join(", ")}`);
  check("3  the safe change adds exactly one operation to the change set", buildChangeSet(demo("proposed-change-safe")).length === buildChangeSet(reference).length + 1, "36 operations against 35");

  // Step 4: you do not need all the data first. A partial config checks and draws what it has.
  const p1 = runAgent({ stages, config: demo("partial-1-ngfw"), until: "03" });
  const p1Text = renderMermaid(demo("partial-1-ngfw"));
  check("4  firewall zones alone are checked and drawn", p1.status === "healthy-partial" && p1.through === "03" && p1Text.includes("zone untrust") && !p1Text.includes("F5 virtual server"), "healthy through stage 03, no F5 yet");
  const p2 = runAgent({ stages, config: demo("partial-2-ngfw-and-f5"), until: "06" });
  const p2Text = renderMermaid(demo("partial-2-ngfw-and-f5"));
  check("4  adding the F5 grows the picture", p2.status === "healthy-partial" && p2.through === "06" && p2Text.includes("F5 virtual server") && !p2Text.includes("Cloudflare edge"), "healthy through stage 06, F5 appears");

  // Step 5: the same model carries more than one vendor.
  const vendors = [...new Set(buildChangeSet(reference).map((op) => op.vendor))].sort();
  check("5  one change set spans the vendors", vendors.join(",") === "cloudflare,f5,meraki,paloalto", `vendors: ${vendors.join(", ")}`);

  // Step 6: a future-state what-if.
  const rows = sweep(load("scenarios", "rto-wifi.json"));
  check("6  the return-to-office what-if finds the first problems", rows.find((r) => r.dhcpStatus === "over")?.days === 2 && rows.find((r) => r.zonesOver > 0)?.days === 4, "address pool first, then Wi-Fi");

  // Step 7: rehearse a change on a simulated tenant and prove it undoes cleanly.
  const roundtrip = await runRoundtrip(reference, new Date("2026-11-19T12:00:00Z"));
  check("7  apply then destroy leaves the simulated tenant unchanged", roundtrip.ok && roundtrip.symmetric && roundtrip.unmanagedSurvived, `${roundtrip.created} created, ${roundtrip.deleted} deleted`);

  // Step 8: claim exactly against as-built requirements, across vendors.
  const requirements = load("requirements", "example-asbuilt.json");
  const claim = evaluate({ requirements, config: reference, attestations: load("requirements", "example-attestations.json") });
  const c = claim.claim.counts;
  check("8  the as-built claim is exact: 10 met, 1 unmet, 4 indeterminable", c.met === 10 && c.unmet === 1 && c.indeterminable === 4 && c.attested === 1 && c.needs_attestation === 1, `${c.met} met, ${c.unmet} unmet, ${c.indeterminable} indeterminable, ${c.attested} attested, ${c.needs_attestation} needs attestation`);
  const v = Object.fromEntries(claim.results.map((r) => [r.id, r.verdict]));
  check("8  an unmodeled Cisco platform is reported as a gap, not a pass", v["SYN-CORE-001"] === "indeterminable" && claim.results.find((r) => r.id === "SYN-CORE-001").perVendor["cisco-ios"] === "gap", "SYN-CORE-001 cannot say: no mapping for cisco-ios");
  check("8  scoping a requirement to F5 turns a indeterminable into a met", v["SYN-TLS-001"] === "indeterminable" && v["SYN-TLS-002"] === "met", "TLS 1.2 across all vendors cannot say; scoped to F5 it is met");
  check("8  the committed as-built report is current", readFileSync(join(HERE, "..", "docs", "ASBUILT_REPORT.md"), "utf8") === renderAsBuilt(claim), "docs/ASBUILT_REPORT.md equals the engine output");

  return results;
}

export async function main() {
  const results = await runDemoChecks();
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  (${r.detail})`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\nAll ${results.length} demo steps behave as the runbook says.` : `\n${failed} of ${results.length} demo steps do not match the runbook.`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
