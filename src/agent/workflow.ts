import type { Assessment } from "./contracts.js";
import { requestArchitectureRecommendation } from "./claude.js";
import { estimateMonthlyCost, pricingFromEnvironment } from "./cost.js";
import { assessControls } from "./governance.js";
import { validateIntake } from "./validate.js";
import { runtimeConfigFromEnvironment } from "../platform/runtime.js";

export async function runAssessment(rawIntake: unknown, now = new Date()): Promise<Assessment> {
  const intake = validateIntake(rawIntake);
  const cost = estimateMonthlyCost(intake, pricingFromEnvironment());
  const findings = assessControls(intake);
  const budget = runtimeConfigFromEnvironment().monthlyModelBudgetUsd;
  if (budget > 0 && cost.estimatedMonthlyUsd > budget) {
    findings.push({
      id: "COST-001",
      severity: "high",
      message: `Estimated monthly model cost exceeds the configured budget of $${budget.toFixed(2)}.`,
      remediation: "Reduce request volume or token bounds, select an approved lower-cost model, or obtain a reviewed budget increase."
    });
  }
  const claudeRecommendation = await requestArchitectureRecommendation(intake, cost);
  const blocking = findings.filter((finding) => finding.severity === "critical").length;
  const recommendation = claudeRecommendation ?? (blocking > 0
    ? `Hold: remediate ${blocking} critical control finding(s) before an agent pilot.`
    : "Proceed to a bounded, read-only pilot with synthetic data, evaluation cases, human approval, observability, and a documented rollback.");
  const evidence: Assessment["evidence"] = {
    generatedAt: now.toISOString(),
    promptLogged: false
  };
  if (claudeRecommendation && process.env.ANTHROPIC_MODEL) {
    evidence.model = process.env.ANTHROPIC_MODEL;
  }
  return {
    mode: claudeRecommendation ? "claude-assisted" : "deterministic",
    cost,
    findings,
    recommendation,
    evidence
  };
}
