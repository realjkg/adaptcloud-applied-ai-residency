import { readFile } from "node:fs/promises";
import { assessScenario, isScenarioName, scenarioNames } from "./scenarios/registry.js";

const usage = `Usage: npm run scenario -- --scenario=<${scenarioNames.join("|")}> --input=<path> [--cloud=aws|gcp] [--json]

The scenario is always explicit. A fixture that declares a different scenario is rejected rather
than coerced, because silently assessing a payments file as a claim would produce a confident
answer about the wrong domain.`;

function argument(name: string): string | undefined {
  return process.argv.slice(2).find((entry) => entry.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

const scenario = argument("scenario");
const input = argument("input");
const cloud = argument("cloud") ?? "aws";
const json = process.argv.includes("--json");

if (!scenario || !input) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
if (!isScenarioName(scenario)) {
  process.stderr.write(`Unsupported scenario: use one of ${scenarioNames.join(", ")}.\n`);
  process.exit(2);
}
if (cloud !== "aws" && cloud !== "gcp") {
  process.stderr.write("Unsupported cloud: use aws or gcp.\n");
  process.exit(2);
}

let envelope;
try {
  envelope = await assessScenario(scenario, JSON.parse(await readFile(input, "utf8")) as unknown, cloud);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "assessment failed"}\n`);
  process.exit(1);
}

if (json) {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
} else {
  process.stdout.write(`${envelope.scenario} on ${envelope.cloud}: ${envelope.status} (${envelope.mode})\n`);
  process.stdout.write(`human approval required: ${envelope.humanApprovalRequired}\n`);
  process.stdout.write(`estimated monthly model cost: $${envelope.cost.estimatedMonthlyUsd.toFixed(2)}\n`);
  if (envelope.findings.length === 0) {
    process.stdout.write("findings: none\n");
  } else {
    process.stdout.write(`findings (${envelope.findings.length}):\n`);
    for (const finding of envelope.findings) {
      process.stdout.write(`  ${finding.severity.toUpperCase()} ${finding.id} ${finding.message}\n`);
      process.stdout.write(`    remediation: ${finding.remediation}\n`);
    }
  }
  // The envelope carries two different judgements. The scenario status is the domain verdict;
  // the recommendation describes the architecture the assessment saw. Printing the second
  // without labelling it made a blocked result read as "proceed".
  const blocking = envelope.findings.filter((finding) => finding.severity === "critical").length;
  if (blocking > 0) {
    process.stdout.write(`\nBlocked: resolve ${blocking} critical finding(s) before this ${envelope.scenario} case reaches human review.\n`);
  }
  process.stdout.write(`\narchitecture recommendation: ${envelope.recommendation}\n`);
}

if (envelope.status === "blocked") process.exitCode = 1;
