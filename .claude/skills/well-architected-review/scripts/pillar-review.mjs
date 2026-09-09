#!/usr/bin/env node
// Six-pillar readiness review for any non-secret environment profile.
// Policy comes from src/platform/runtime.ts; this script never re-implements it.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();

function ensureBuild() {
  if (existsSync(resolve(repoRoot, "dist/src/platform/runtime.js"))) return;
  process.stderr.write("dist/ missing; running npm run build\n");
  const built = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (built.status !== 0) throw new Error("build_failed: cannot review pillars without compiled policy");
}

function parseEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(resolve(repoRoot, path), "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return env;
}

const pillars = ["security", "resilience", "reliability", "cost-optimization", "sustainability", "operational-efficiency"];

const args = process.argv.slice(2);
const profileArg = args.find((arg) => arg.startsWith("--profile="))?.split("=")[1];
const fileArg = args.find((arg) => arg.startsWith("--env-file="))?.split("=")[1];
const json = args.includes("--json");

const profiles = profileArg === "all" || (!profileArg && !fileArg)
  ? ["development", "sandbox", "qa", "staging", "production"]
  : profileArg
    ? [profileArg]
    : [];

const targets = fileArg
  ? [{ label: fileArg, path: fileArg }]
  : profiles.map((name) => ({ label: name, path: `config/${name}-reference.env` }));

ensureBuild();
const { runtimeConfigFromEnvironment, assessRuntimeReadiness } = await import(
  resolve(repoRoot, "dist/src/platform/runtime.js")
);

const report = [];
let blockingTotal = 0;

for (const target of targets) {
  if (!existsSync(resolve(repoRoot, target.path))) {
    report.push({ profile: target.label, error: `missing profile file: ${target.path}` });
    blockingTotal += 1;
    continue;
  }
  const env = parseEnvFile(target.path);
  let config;
  try {
    config = runtimeConfigFromEnvironment(env);
  } catch (error) {
    report.push({ profile: target.label, error: `invalid contract: ${error.message}` });
    blockingTotal += 1;
    continue;
  }
  const findings = assessRuntimeReadiness(config);
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  // Only production must fail closed. Earlier stages surface the same findings as
  // a promotion backlog, which is what makes the gap list useful before staging.
  if (config.environment === "production") blockingTotal += blockers.length;
  report.push({
    profile: target.label,
    environment: config.environment,
    failsClosed: config.environment === "production",
    byPillar: Object.fromEntries(pillars.map((pillar) => [
      pillar,
      findings.filter((finding) => finding.pillar === pillar).map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        message: finding.message
      }))
    ])),
    blockers: blockers.map((finding) => finding.id),
    warnings: warnings.map((finding) => finding.id),
    dataRetentionDays: config.dataRetentionDays,
    monthlyModelBudgetUsd: config.monthlyModelBudgetUsd
  });
}

if (json) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", report }, null, 2)}\n`);
} else {
  for (const entry of report) {
    if (entry.error) {
      process.stdout.write(`\n${entry.profile}: ERROR ${entry.error}\n`);
      continue;
    }
    const verdict = entry.blockers.length === 0 ? "no blocking findings" : `${entry.blockers.length} blocker(s)`;
    process.stdout.write(`\n${entry.profile} (APP_ENV=${entry.environment}) — ${verdict}\n`);
    for (const pillar of pillars) {
      const findings = entry.byPillar[pillar];
      const mark = findings.length === 0 ? "ok  " : "gap ";
      process.stdout.write(`  ${mark} ${pillar}\n`);
      for (const finding of findings) {
        process.stdout.write(`       ${finding.severity === "blocker" ? "BLOCKER" : "warning"} ${finding.id} ${finding.message}\n`);
      }
    }
    process.stdout.write(`       budget=$${entry.monthlyModelBudgetUsd} retentionDays=${entry.dataRetentionDays}\n`);
  }
  process.stdout.write("\nA clean reference profile proves contract consistency only. It is not production authorization.\n");
}

if (blockingTotal > 0) process.exitCode = 1;
