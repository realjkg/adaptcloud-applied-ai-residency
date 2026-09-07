import { readFile } from "node:fs/promises";
import { runAssessment } from "../src/agent/workflow.js";

interface EvalCase { name: string; input: string | unknown; expectedCriticalFindings: number }
const cases = JSON.parse(await readFile("evals/cases.json", "utf8")) as EvalCase[];
let failures = 0;
for (const item of cases) {
  const input = typeof item.input === "string" ? JSON.parse(await readFile(item.input, "utf8")) as unknown : item.input;
  const result = await runAssessment(input, new Date("2026-01-01T00:00:00.000Z"));
  const critical = result.findings.filter((finding) => finding.severity === "critical").length;
  const passed = critical === item.expectedCriticalFindings;
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${item.name}: critical=${critical}\n`);
  if (!passed) failures += 1;
}
if (failures > 0) process.exitCode = 1;
