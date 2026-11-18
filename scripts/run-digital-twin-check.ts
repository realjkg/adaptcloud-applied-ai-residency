import { readFile } from "node:fs/promises";
import { applyTwinFault, checkDigitalTwin, TWIN_FAULTS } from "../src/labs/digital-twin.js";

// Usage:
//   npm run twin:check                         check the baseline spec (exit 1 if blocked)
//   npm run twin:check -- --input=my-twin.json check a student-edited copy
//   npm run twin:check -- --list-faults        list the deliberate fault catalog
//   npm run twin:check -- --fault=F1-bypass-ngfw
//                                              inject one fault; exit 0 only if the expected finding fires
const args = process.argv.slice(2);
const valueFor = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

if (args.includes("--list-faults")) {
  console.log(JSON.stringify(TWIN_FAULTS.map(({ id, description, expectedFinding }) => ({ id, description, expectedFinding })), null, 2));
  process.exit(0);
}

const inputPath = valueFor("--input") ?? "examples/labs/digital-twin.json";
const baseline: unknown = JSON.parse(await readFile(inputPath, "utf8"));
const faultId = valueFor("--fault");

if (faultId === undefined) {
  const result = checkDigitalTwin(baseline);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "ready_for_human_review" ? 0 : 1);
}

const fault = TWIN_FAULTS.find((candidate) => candidate.id === faultId);
if (!fault) {
  console.error(`unknown fault ${faultId}; run with --list-faults`);
  process.exit(2);
}

const result = checkDigitalTwin(applyTwinFault(baseline, faultId));
const detected = result.findings.some((finding) => finding.id === fault.expectedFinding);
console.log(JSON.stringify({
  fault: fault.id,
  expectedFinding: fault.expectedFinding,
  detected,
  findingIds: [...new Set(result.findings.map((finding) => finding.id))]
}, null, 2));
process.exit(detected ? 0 : 1);
