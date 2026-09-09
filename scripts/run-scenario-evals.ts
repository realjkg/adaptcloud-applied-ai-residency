import { readFile } from "node:fs/promises";
import { runLabSimulation, type CloudTarget, type LabInput, type LabScenario } from "../src/labs/simulator.js";

interface ScenarioEvalCase {
  name: string;
  scenario: LabScenario;
  input: string | unknown;
  cloud?: CloudTarget;
  expectedStatus: "ready_for_human_review" | "blocked";
  expectedFindings: string[];
}

const SCENARIOS: LabScenario[] = ["commercial", "payments", "insurance"];
// Scenario policy findings are the contract under test; architecture findings are asserted by evals/cases.json.
const PREFIX: Record<LabScenario, string> = { commercial: "COM-", payments: "PAY-", insurance: "INS-" };

const scenarioArg = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
const jsonOutput = new Set(process.argv.slice(2)).has("--json");
if (scenarioArg && scenarioArg !== "all" && !SCENARIOS.includes(scenarioArg as LabScenario)) throw new Error("unsupported --scenario");
const selected: LabScenario[] = scenarioArg && scenarioArg !== "all" ? [scenarioArg as LabScenario] : SCENARIOS;

// Evaluations must be deterministic and network-free regardless of local configuration.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const cases = (JSON.parse(await readFile("evals/scenario-cases.json", "utf8")) as ScenarioEvalCase[])
  .filter((item) => selected.includes(item.scenario));

const results: Array<{ name: string; scenario: LabScenario; passed: boolean; status: string; expectedStatus: string; findings: string[]; expectedFindings: string[] }> = [];
let failures = 0;
for (const item of cases) {
  const input = (typeof item.input === "string" ? JSON.parse(await readFile(item.input, "utf8")) : item.input) as LabInput;
  const result = await runLabSimulation(input, item.cloud ?? "aws", new Date("2026-01-01T00:00:00.000Z"));
  const actual = sorted(result.findings.filter((f) => f.id.startsWith(PREFIX[item.scenario])).map((f) => f.id));
  const expected = sorted(item.expectedFindings);
  const passed = result.status === item.expectedStatus && actual.join(",") === expected.join(",");
  results.push({ name: item.name, scenario: item.scenario, passed, status: result.status, expectedStatus: item.expectedStatus, findings: actual, expectedFindings: expected });
  if (!passed) failures += 1;
  if (!jsonOutput) {
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${item.scenario}: ${item.name} status=${result.status} findings=[${actual.join(" ")}]${passed ? "" : ` expected status=${item.expectedStatus} findings=[${expected.join(" ")}]`}\n`);
  }
}
if (jsonOutput) process.stdout.write(`${JSON.stringify({ total: results.length, failures, cases: results }, null, 2)}\n`);
else process.stdout.write(`${results.length - failures}/${results.length} scenario eval cases passed\n`);
if (failures > 0) process.exitCode = 1;
