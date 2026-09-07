import type { CostEstimate, ProjectIntake } from "./contracts.js";

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function pricingFromEnvironment(env: NodeJS.ProcessEnv = process.env): Pricing {
  const inputPerMillion = Number(env.INPUT_COST_PER_MTOK ?? 0);
  const outputPerMillion = Number(env.OUTPUT_COST_PER_MTOK ?? 0);
  if (![inputPerMillion, outputPerMillion].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error("model pricing must be finite and non-negative");
  }
  return { inputPerMillion, outputPerMillion };
}

export function estimateMonthlyCost(intake: ProjectIntake, pricing: Pricing): CostEstimate {
  const monthlyInputTokens = intake.monthlyRequests * intake.averageInputTokens;
  const monthlyOutputTokens = intake.monthlyRequests * intake.averageOutputTokens;
  const estimatedMonthlyUsd =
    (monthlyInputTokens / 1_000_000) * pricing.inputPerMillion +
    (monthlyOutputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    monthlyInputTokens,
    monthlyOutputTokens,
    estimatedMonthlyUsd: Number(estimatedMonthlyUsd.toFixed(2)),
    pricingSource: "environment"
  };
}
