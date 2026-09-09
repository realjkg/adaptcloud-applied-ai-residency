#!/usr/bin/env node
// Evaluate cumulative promotion evidence for one or every environment.
//
// Gate definitions live in src/platform/promotion.ts. This script reports which gates a
// target stage still needs and which pillar each gap belongs to, so a review conversation
// starts from a specific list rather than a general impression of readiness.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();
const args = process.argv.slice(2);
const json = args.includes("--json");
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const evidencePath = value("evidence") ?? "examples/promotion-evidence.simulated.json";
const requested = value("environment") ?? "all";

function ensureBuild() {
  if (existsSync(resolve(repoRoot, "dist/src/platform/promotion.js"))) return;
  process.stderr.write("dist/ missing; running npm run build\n");
  const built = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (built.status !== 0) throw new Error("build_failed: cannot evaluate gates without the compiled policy");
}

ensureBuild();
const { evaluatePromotion, promotionEnvironments, promotionGates, requiredGatesFor } = await import(
  resolve(repoRoot, "dist/src/platform/promotion.js")
);

if (requested !== "all" && !promotionEnvironments.includes(requested)) {
  process.stderr.write(`Unsupported environment: ${requested}. Use one of ${promotionEnvironments.join(", ")} or all.\n`);
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(resolve(repoRoot, evidencePath), "utf8"));
const targets = requested === "all" ? [...promotionEnvironments] : [requested];
const results = targets.map((environment) => evaluatePromotion(environment, evidence, new Date()));

if (json) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", evidencePath, results }, null, 2)}\n`);
} else {
  process.stdout.write(`Evidence: ${evidencePath}\n`);
  process.stdout.write(`Mode: ${evidence.evidenceMode}  commit: ${evidence.commitSha}  artifact: ${evidence.artifactDigest}\n`);
  process.stdout.write("The same artifact digest must appear at every stage; a rebuild between stages invalidates earlier evidence.\n");
  for (const result of results) {
    const verdict = result.readyForHumanReview ? "ready for human review" : `${result.missingGates.length} gate(s) missing`;
    process.stdout.write(`\n${result.targetEnvironment} — ${verdict} (${result.requiredGates.length} cumulative gates)\n`);
    for (const [pillar, gates] of Object.entries(result.findingsByPillar)) {
      process.stdout.write(`  ${pillar}\n`);
      for (const gate of gates) {
        process.stdout.write(`    missing  ${gate}  (earned at stage: ${promotionGates[gate].stage})\n`);
      }
    }
    if (result.missingGates.length === 0) {
      const owned = requiredGatesFor(result.targetEnvironment).filter((gate) => promotionGates[gate].stage === result.targetEnvironment);
      process.stdout.write(`  all cumulative gates satisfied; ${owned.length} of them earned at this stage\n`);
    }
    process.stdout.write(`  deploymentAuthorized: ${result.deploymentAuthorized} — readiness is never authorization\n`);
  }
  process.stdout.write("\nRecord each gate's reference in docs/templates/PROMOTION_EVIDENCE.md before review.\n");
}

if (results.some((result) => !result.readyForHumanReview)) process.exitCode = 1;
