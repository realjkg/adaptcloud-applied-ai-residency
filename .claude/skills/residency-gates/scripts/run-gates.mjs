#!/usr/bin/env node
// Run the repository's definition-of-done gates and emit the evidence summary they support.
//
// CLAUDE.md rule 6 names four gates that must pass before work is declared complete, and
// rule 7 requires an evidence summary. Running them by hand invites a quietly skipped step,
// so this records what actually ran, what it returned, and how long it took.
import { spawnSync } from "node:child_process";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();
const args = process.argv.slice(2);
const json = args.includes("--json");
const full = args.includes("--full");
const evidenceOnly = args.includes("--evidence");

// The required four come straight from CLAUDE.md. The extended set covers the scenario and
// promotion surfaces, which a change touching those areas should not leave unproven.
const required = [
  { id: "typecheck", command: "npm", argv: ["run", "check"], proves: "the contract compiles under strict TypeScript" },
  { id: "unit-tests", command: "npm", argv: ["test"], proves: "positive, negative, and adversarial behaviour holds" },
  { id: "agent-evaluations", command: "npm", argv: ["run", "eval"], proves: "the agent still meets its evaluation cases offline" },
  { id: "production-readiness", command: "npm", argv: ["run", "readiness:production-reference"], proves: "the production contract has no blocking six-pillar finding" }
];

const extended = [
  { id: "scenario-simulations", command: "npm", argv: ["run", "lab:simulate"], proves: "all three scenarios stay reviewable on both cloud contracts" },
  { id: "promotion-evidence", command: "npm", argv: ["run", "promotion:simulate", "--", "--environment=all"], proves: "cumulative promotion evidence still evaluates" },
  { id: "trust-boundaries", command: "node", argv: [".claude/skills/cca-f-architecture-review/scripts/scan-boundaries.mjs"], proves: "no known trust-boundary crossing was introduced" }
];

const gates = full ? [...required, ...extended] : required;

function changedFiles() {
  const working = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  const lines = (working.stdout ?? "").split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
  if (lines.length > 0) return lines;
  const committed = spawnSync("git", ["diff", "--name-only", "origin/main...HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return (committed.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

const results = [];
if (!evidenceOnly) {
  for (const gate of gates) {
    const started = Date.now();
    const run = spawnSync(gate.command, gate.argv, { cwd: repoRoot, encoding: "utf8" });
    const durationMs = Date.now() - started;
    const passed = run.status === 0;
    // Keep the tail rather than the whole log: a failing gate's cause is nearly always at
    // the end, and full output would bury the summary this script exists to produce.
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    results.push({ id: gate.id, proves: gate.proves, passed, exitCode: run.status, durationMs, tail });
    if (!json) {
      process.stdout.write(`${passed ? "PASS" : "FAIL"} ${gate.id} (${(durationMs / 1000).toFixed(1)}s) — ${gate.proves}\n`);
      if (!passed) process.stdout.write(`${tail.split("\n").map((line) => `     ${line}`).join("\n")}\n`);
    }
  }
}

const failed = results.filter((result) => !result.passed);
const files = changedFiles();

const summary = [
  "## Evidence summary",
  "",
  "### Files changed",
  files.length > 0 ? files.map((file) => `- \`${file}\``).join("\n") : "- none detected",
  "",
  "### Gates",
  results.length > 0
    ? results.map((result) => `- ${result.passed ? "pass" : "FAIL"} \`${result.id}\` — ${result.proves} (${(result.durationMs / 1000).toFixed(1)}s)`).join("\n")
    : "- not run in this invocation",
  "",
  "### Residual risks",
  "- _State what remains unproven: unexercised failure modes, assumptions carried, controls owed to a real engagement._",
  "",
  "### Rollback",
  "- _State how to reverse this change: revert target, configuration to restore, and the signal that says to do it._",
  "",
  "> Passing gates show the change is internally consistent. They are not production authorization,",
  "> and they do not replace owner review, threat modelling, or customer acceptance."
].join("\n");

if (json) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", gates: results, changedFiles: files, allPassed: failed.length === 0 }, null, 2)}\n`);
} else {
  process.stdout.write(`\n${summary}\n`);
  if (failed.length > 0) {
    process.stdout.write(`\n${failed.length} gate(s) failed. The work is not done; fix the cause rather than weakening the gate.\n`);
  }
}

if (failed.length > 0) process.exitCode = 1;
