import { readFile } from "node:fs/promises";
import {
  evaluatePromotion,
  promotionEnvironments,
  type PromotionEnvironment,
  type PromotionEvidence
} from "../src/platform/promotion.js";

const args = process.argv.slice(2);
const valueFor = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const requestedEnvironment = valueFor("--environment") ?? "all";
const evidencePath = valueFor("--evidence") ?? "examples/promotion-evidence.simulated.json";
const commitSha = valueFor("--commit-sha");
const artifactDigest = valueFor("--artifact-digest");
const evaluatedAt = new Date(valueFor("--evaluated-at") ?? "2026-01-01T00:00:00.000Z");

if (Number.isNaN(evaluatedAt.valueOf())) throw new Error("--evaluated-at must be an ISO-8601 timestamp");
if (requestedEnvironment !== "all" && !promotionEnvironments.includes(requestedEnvironment as PromotionEnvironment)) {
  throw new Error("--environment must be development, sandbox, qa, staging, production, or all");
}

const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as PromotionEvidence;
const evidence: PromotionEvidence = {
  ...parsed,
  commitSha: commitSha ?? parsed.commitSha,
  artifactDigest: artifactDigest ?? parsed.artifactDigest
};
const targets = requestedEnvironment === "all"
  ? promotionEnvironments
  : [requestedEnvironment as PromotionEnvironment];
const evaluations = targets.map((target) => evaluatePromotion(target, evidence, evaluatedAt));

process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0",
  exercise: "environment-promotion",
  warning: "Evaluation evidence does not deploy or authorize an environment.",
  evaluations
}, null, 2)}\n`);

if (evaluations.some((evaluation) => !evaluation.readyForHumanReview)) process.exitCode = 1;
