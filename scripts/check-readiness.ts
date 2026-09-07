import { assessRuntimeReadiness, runtimeConfigFromEnvironment } from "../src/platform/runtime.js";

const config = runtimeConfigFromEnvironment();
const findings = assessRuntimeReadiness(config);
const blockers = findings.filter((finding) => finding.severity === "blocker");
const enforcedBlockers = config.environment === "production" ? blockers : [];

process.stdout.write(`${JSON.stringify({
  environment: config.environment,
  ready: enforcedBlockers.length === 0,
  productionControlsSatisfied: blockers.length === 0,
  findings
}, null, 2)}\n`);

if (enforcedBlockers.length > 0) process.exitCode = 1;
