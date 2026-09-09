import { runLabSimulation, type CloudTarget } from "../labs/simulator.js";
import { commercialModule } from "./commercial.js";
import { parseScenarioRequest, type ScenarioEnvelope, type ScenarioName } from "./contracts.js";
import { insuranceModule } from "./insurance.js";
import { paymentsModule } from "./payments.js";

export const scenarioModules = [commercialModule, paymentsModule, insuranceModule] as const;

export const scenarioNames: readonly ScenarioName[] = scenarioModules.map((module) => module.name);

export function isScenarioName(value: unknown): value is ScenarioName {
  return typeof value === "string" && (scenarioNames as readonly string[]).includes(value);
}

export async function assessScenario(
  scenario: ScenarioName,
  rawInput: unknown,
  cloud: CloudTarget,
  now = new Date()
): Promise<ScenarioEnvelope> {
  const request = parseScenarioRequest(scenario, rawInput);
  const result = await runLabSimulation(request, cloud, now);
  const evidence: ScenarioEnvelope["evidence"] = {
    generatedAt: result.evidence.generatedAt,
    terraformRoot: result.evidence.terraformRoot,
    promptLogged: false,
    sensitiveContentLogged: false
  };
  // The nested assessment only records a model when Claude actually answered.
  if (result.architecture.evidence.model !== undefined) evidence.model = result.architecture.evidence.model;
  return {
    schemaVersion: result.schemaVersion,
    scenario: result.scenario,
    cloud: result.cloud,
    mode: result.architecture.mode,
    status: result.status,
    humanApprovalRequired: result.humanApprovalRequired,
    findings: result.findings,
    cost: result.architecture.cost,
    domain: result.domain,
    recommendation: result.architecture.recommendation,
    evidence
  };
}
