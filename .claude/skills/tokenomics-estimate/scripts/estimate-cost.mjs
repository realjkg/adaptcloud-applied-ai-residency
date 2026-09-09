#!/usr/bin/env node
// Deterministic token-cost estimate for an intake, using operator-supplied pricing only.
//
// Pricing is never inferred. If the operator has not supplied it, the estimate refuses to
// run: a made-up rate produces a confident number that a client would treat as a quote.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();
const args = process.argv.slice(2);
const json = args.includes("--json");
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const intakePath = value("intake") ?? "examples/client-intake.json";
const inputCost = value("input-cost") ?? process.env.INPUT_COST_PER_MTOK;
const outputCost = value("output-cost") ?? process.env.OUTPUT_COST_PER_MTOK;
const budget = Number(value("budget") ?? process.env.MONTHLY_MODEL_BUDGET_USD ?? 0);
const outcomeRate = Number(value("outcome-rate") ?? 1);

if (inputCost === undefined || outputCost === undefined) {
  process.stderr.write(
    "Refusing to estimate without pricing.\n" +
    "Supply the rates the fork owner approved for the chosen model:\n" +
    "  --input-cost=<usd per million input tokens> --output-cost=<usd per million output tokens>\n" +
    "or set INPUT_COST_PER_MTOK and OUTPUT_COST_PER_MTOK. Published rates change; ask the owner rather than recalling one.\n"
  );
  process.exit(2);
}

function ensureBuild() {
  if (existsSync(resolve(repoRoot, "dist/src/agent/cost.js"))) return;
  process.stderr.write("dist/ missing; running npm run build\n");
  const built = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (built.status !== 0) throw new Error("build_failed: cannot estimate without the compiled cost model");
}

ensureBuild();
const { estimateMonthlyCost } = await import(resolve(repoRoot, "dist/src/agent/cost.js"));
const { validateIntake } = await import(resolve(repoRoot, "dist/src/agent/validate.js"));

const intake = validateIntake(JSON.parse(readFileSync(resolve(repoRoot, intakePath), "utf8")));
const pricing = { inputPerMillion: Number(inputCost), outputPerMillion: Number(outputCost) };
if (![pricing.inputPerMillion, pricing.outputPerMillion].every((rate) => Number.isFinite(rate) && rate >= 0)) {
  process.stderr.write("Pricing must be finite and non-negative.\n");
  process.exit(2);
}

const estimate = estimateMonthlyCost(intake, pricing);
const perRequest = intake.monthlyRequests > 0 ? estimate.estimatedMonthlyUsd / intake.monthlyRequests : 0;
const reviewedOutcomes = Math.max(0, Math.round(intake.monthlyRequests * outcomeRate));
const perOutcome = reviewedOutcomes > 0 ? estimate.estimatedMonthlyUsd / reviewedOutcomes : 0;
const overBudget = budget > 0 && estimate.estimatedMonthlyUsd > budget;

// Volume is the assumption clients revise most often, so show the shape of the curve
// rather than a single point estimate.
const sensitivity = [0.5, 1, 2, 5].map((factor) => ({
  factor,
  monthlyRequests: Math.round(intake.monthlyRequests * factor),
  usd: Number((estimate.estimatedMonthlyUsd * factor).toFixed(2)),
  withinBudget: budget === 0 ? null : estimate.estimatedMonthlyUsd * factor <= budget
}));

const result = {
  schemaVersion: "1.0",
  intakePath,
  pricing: { ...pricing, source: value("input-cost") ? "argument" : "environment" },
  estimate,
  unitEconomics: {
    usdPerRequest: Number(perRequest.toFixed(6)),
    reviewedOutcomesPerMonth: reviewedOutcomes,
    usdPerReviewedOutcome: Number(perOutcome.toFixed(6)),
    outcomeRate
  },
  budget: { monthlyUsd: budget, overBudget, headroomUsd: budget > 0 ? Number((budget - estimate.estimatedMonthlyUsd).toFixed(2)) : null },
  sensitivity,
  note: "Deterministic estimate from operator-supplied pricing. It is not a quote and excludes platform, storage, egress, and human-review cost."
};

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`Intake: ${intakePath} (${intake.industry})\n`);
  process.stdout.write(`Pricing: $${pricing.inputPerMillion}/Mtok in, $${pricing.outputPerMillion}/Mtok out (${result.pricing.source})\n\n`);
  process.stdout.write(`Monthly input tokens   ${estimate.monthlyInputTokens.toLocaleString()}\n`);
  process.stdout.write(`Monthly output tokens  ${estimate.monthlyOutputTokens.toLocaleString()}\n`);
  process.stdout.write(`Estimated monthly cost $${estimate.estimatedMonthlyUsd.toFixed(2)}\n`);
  process.stdout.write(`Cost per request       $${perRequest.toFixed(6)}\n`);
  process.stdout.write(`Cost per reviewed outcome $${perOutcome.toFixed(6)} (${reviewedOutcomes} outcomes at rate ${outcomeRate})\n\n`);
  if (budget > 0) {
    process.stdout.write(overBudget
      ? `BUDGET BREACH: $${estimate.estimatedMonthlyUsd.toFixed(2)} exceeds the $${budget.toFixed(2)} monthly budget.\n`
      : `Within budget: $${(budget - estimate.estimatedMonthlyUsd).toFixed(2)} headroom against $${budget.toFixed(2)}.\n`);
    process.stdout.write("The runtime raises COST-001 as a deterministic finding on breach; it is not a model judgement.\n\n");
  } else {
    process.stdout.write("No budget supplied. Production readiness requires an explicit budget (COST-001).\n\n");
  }
  process.stdout.write("Volume sensitivity\n");
  for (const row of sensitivity) {
    const verdict = row.withinBudget === null ? "" : row.withinBudget ? "  within budget" : "  OVER BUDGET";
    process.stdout.write(`  ${String(row.factor).padStart(4)}x  ${String(row.monthlyRequests).padStart(9)} req  $${row.usd.toFixed(2)}${verdict}\n`);
  }
  process.stdout.write(`\n${result.note}\n`);
}

if (overBudget) process.exitCode = 1;
