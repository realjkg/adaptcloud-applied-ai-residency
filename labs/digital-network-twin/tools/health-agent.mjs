#!/usr/bin/env node
// Health agent: builds the twin one stage at a time and checks the config after each stage.
// Loop: apply the next stage to the twin, run that stage's checks against the config, then
// continue only if every check passed. A failure halts the run (fail-closed), so no later stage
// is checked against a config that is already unhealthy.
//
// Read-only. It never edits the config, never contacts a device, and prints check ids and
// field names only, not config values.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applySequence, loadStages, plan } from "./twin-sequence.mjs";
import { runStageChecks } from "./health.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = join(HERE, "..", "config", "twin-config.json");

const byId = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/** Runs the build-and-check loop. `until` stops after that stage id, inclusive. */
export function runAgent({ stages, config, until }) {
  const ordered = plan(stages);
  const report = { status: "healthy", through: null, stages: [], halted: null };
  const ids = [];

  for (const stage of ordered) {
    if (until !== undefined && byId(stage.id, until) > 0) break;
    ids.push(stage.id);

    const applied = applySequence(stages, ids).steps.at(-1);
    if (applied.status !== "applied" && applied.status !== "already-applied") {
      report.status = "halted";
      report.halted = { stage: stage.id, reason: "twin refused the stage", missing: applied.missing ?? [], failing: [] };
      return report;
    }

    const checks = runStageChecks(stage.id, config);
    report.stages.push({ stage: stage.id, title: stage.title, checks });
    const failing = checks.filter((check) => !check.ok);
    if (failing.length > 0) {
      report.status = "halted";
      report.halted = { stage: stage.id, reason: "health checks failed", missing: [], failing: failing.map((check) => check.id) };
      return report;
    }
    report.through = stage.id;
  }

  if (until !== undefined && report.through !== ordered.at(-1)?.id) report.status = "healthy-partial";
  return report;
}

function print(report) {
  for (const entry of report.stages) {
    console.log(`STAGE ${entry.stage}  ${entry.title}`);
    for (const check of entry.checks) {
      console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.id}${check.ok ? "" : `  ${check.message}`}`);
    }
  }
  if (report.status === "halted") {
    const { stage, reason, failing, missing } = report.halted;
    console.log(`\nHALTED at stage ${stage}: ${reason}${failing.length ? ` (${failing.join(", ")})` : ""}${missing.length ? ` (missing ${missing.join(", ")})` : ""}.`);
    console.log("No later stage was checked. Fix the config, not the check. Item details: docs/CHECKLIST.md");
  } else if (report.status === "healthy-partial") {
    console.log(`\nHEALTHY through stage ${report.through}. Later stages were not checked.`);
  } else {
    console.log(`\nHEALTHY: all stages passed through ${report.through}.`);
  }
}

export async function main(argv) {
  const valueFor = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const configPath = valueFor("--config") ?? DEFAULT_CONFIG;
  const until = valueFor("--until");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    console.error("could not read the config as JSON");
    return 2;
  }
  const report = runAgent({ stages: loadStages(), config, until });
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
  return report.status === "halted" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
