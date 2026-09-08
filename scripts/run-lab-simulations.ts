import { readFile } from "node:fs/promises";
import { runLabSimulation, type CloudTarget, type LabInput, type LabScenario } from "../src/labs/simulator.js";

const args = new Set(process.argv.slice(2));
const liveClaude = args.has("--claude-live");
const scenarioArg = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
const cloudArg = process.argv.find((arg) => arg.startsWith("--cloud="))?.split("=")[1];
const scenarios: LabScenario[] = scenarioArg && scenarioArg !== "all" ? [scenarioArg as LabScenario] : ["commercial", "payments", "insurance"];
const clouds: CloudTarget[] = cloudArg && cloudArg !== "all" ? [cloudArg as CloudTarget] : ["aws", "gcp"];

if (scenarios.some((scenario) => !["commercial", "payments", "insurance"].includes(scenario))) throw new Error("unsupported --scenario");
if (clouds.some((cloud) => !["aws", "gcp"].includes(cloud))) throw new Error("unsupported --cloud");
if (liveClaude && (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL)) throw new Error("--claude-live requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL");
if (!liveClaude) {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
}

let failures = 0;
for (const scenario of scenarios) {
  const input = JSON.parse(await readFile(`examples/labs/${scenario}.json`, "utf8")) as LabInput;
  for (const cloud of clouds) {
    const result = await runLabSimulation(input, cloud, new Date("2026-01-01T00:00:00.000Z"));
    const passed = result.status === "ready_for_human_review";
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${scenario}/${cloud}: mode=${result.architecture.mode} findings=${result.findings.length} terraform=${result.evidence.terraformRoot}\n`);
    if (!passed) failures += 1;
  }
}
if (failures > 0) process.exitCode = 1;
