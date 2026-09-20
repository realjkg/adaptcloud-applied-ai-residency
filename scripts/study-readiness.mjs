#!/usr/bin/env node
// Deterministic readiness report for the CCAR-P study bank.
//
// The bank lives in study/ccar-p as line-oriented JSONL with stable ids, so it diffs,
// compresses, and appends without rewriting prior content. This script never grades from a
// self-reported score: an attempt records the option chosen per question id, and the script
// compares it to the bank. The estimated scaled score is a study signal, not Anthropic's
// scoring model.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();
const bankDir = resolve(repoRoot, "study/ccar-p");
const args = process.argv.slice(2);
const json = args.includes("--json");
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const readJsonl = (name) =>
  readFileSync(join(bankDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${name}:${index + 1} is not valid JSON: ${error.message}`);
      }
    });

const blueprint = JSON.parse(readFileSync(join(bankDir, "blueprint.json"), "utf8"));
const rules = readJsonl("rules.jsonl");
const terms = readJsonl("terminology.jsonl");
const questions = readJsonl("questions.jsonl");

const domainIds = new Set(blueprint.domains.map((domain) => domain.id));
const ruleIds = new Set(rules.map((rule) => rule.id));
const questionById = new Map(questions.map((question) => [question.id, question]));

// Referential integrity. A bank that points at a domain or rule that does not exist cannot
// support a readiness claim, so this fails loudly rather than scoring around the gap.
const defects = [];
const checkRefs = (records, label) => {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.id)) defects.push(`${label} ${record.id}: duplicate id`);
    seen.add(record.id);
    if (!domainIds.has(record.d)) defects.push(`${label} ${record.id}: unknown domain ${record.d}`);
    for (const rule of record.rules ?? []) {
      if (!ruleIds.has(rule)) defects.push(`${label} ${record.id}: unknown rule ${rule}`);
    }
  }
};
checkRefs(terms, "term");
checkRefs(questions, "question");
for (const rule of rules) if (!domainIds.has(rule.d)) defects.push(`rule ${rule.id}: unknown domain ${rule.d}`);
for (const question of questions) {
  if (!Object.keys(question.opts ?? {}).includes(question.ans)) {
    defects.push(`question ${question.id}: answer ${question.ans} is not one of its options`);
  }
}
const weightTotal = blueprint.domains.reduce((sum, domain) => sum + domain.weight, 0);
if (Math.abs(weightTotal - 1) > 0.005) defects.push(`blueprint weights sum to ${weightTotal.toFixed(3)}, not 1`);

// Digest ties a readiness figure to the exact bank content that produced it, the same way
// promotion evidence ties every stage to one artifact.
const digest = createHash("sha256")
  .update(["blueprint.json", "rules.jsonl", "terminology.jsonl", "questions.jsonl"].map((name) => readFileSync(join(bankDir, name))).join("\n"))
  .digest("hex")
  .slice(0, 12);

const attemptsDir = join(bankDir, "attempts");
const requested = value("attempt");
const attemptFiles = requested
  ? [resolve(repoRoot, requested)]
  : existsSync(attemptsDir)
    ? readdirSync(attemptsDir).filter((name) => name.endsWith(".json")).sort().map((name) => join(attemptsDir, name))
    : [];

const attempts = attemptFiles.map((path) => {
  const attempt = JSON.parse(readFileSync(path, "utf8"));
  const graded = Object.entries(attempt.responses ?? {}).map(([id, chosen]) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`attempt ${attempt.id}: response for unknown question ${id}`);
    return { id, d: question.d, chosen, correct: chosen === question.ans, rules: question.rules ?? [] };
  });
  return { path, attempt, graded };
});

const latest = attempts.at(-1);
const byDomain = blueprint.domains.map((domain) => {
  const target = Math.round(domain.weight * blueprint.format.items);
  const banked = questions.filter((question) => question.d === domain.id).length;
  const termCount = terms.filter((term) => term.d === domain.id).length;
  const answered = latest ? latest.graded.filter((row) => row.d === domain.id) : [];
  const correct = answered.filter((row) => row.correct).length;
  return {
    id: domain.id,
    name: domain.name,
    weight: domain.weight,
    targetItems: target,
    bankedItems: banked,
    bankGap: Math.max(0, target - banked),
    terms: termCount,
    answered: answered.length,
    correct,
    accuracy: answered.length > 0 ? correct / answered.length : null,
  };
});

// Weighted only over domains the attempt actually covered, so an unanswered domain reads as
// missing coverage rather than silently scoring zero.
const covered = byDomain.filter((domain) => domain.answered > 0);
const coveredWeight = covered.reduce((sum, domain) => sum + domain.weight, 0);
const weightedAccuracy = coveredWeight > 0 ? covered.reduce((sum, d) => sum + d.weight * d.accuracy, 0) / coveredWeight : null;
const { scaleMin, scaleMax, passScaled } = blueprint.format;
const estimatedScaled = weightedAccuracy === null ? null : Math.round(scaleMin + (scaleMax - scaleMin) * weightedAccuracy);
const accuracyForPass = (passScaled - scaleMin) / (scaleMax - scaleMin);
const missedRules = latest
  ? [...new Set(latest.graded.filter((row) => !row.correct).flatMap((row) => row.rules))].sort()
  : [];

const report = {
  schemaVersion: "1.0",
  exam: blueprint.code,
  digest,
  provenance: blueprint.provenance,
  bank: { rules: rules.length, terms: terms.length, questions: questions.length },
  defects,
  domains: byDomain,
  attempt: latest
    ? {
        id: latest.attempt.id,
        date: latest.attempt.date,
        mode: latest.attempt.mode,
        answered: latest.graded.length,
        correct: latest.graded.filter((row) => row.correct).length,
        coveredWeight: Number(coveredWeight.toFixed(2)),
        weightedAccuracy: weightedAccuracy === null ? null : Number(weightedAccuracy.toFixed(4)),
        estimatedScaled,
        meetsStudyTarget: estimatedScaled !== null && estimatedScaled >= passScaled,
        missedRules,
      }
    : null,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`CCAR-P study bank — digest ${digest}\n`);
  process.stdout.write(`Blueprint provenance: ${blueprint.provenance.status} — ${blueprint.provenance.note}\n\n`);
  process.stdout.write(`${"domain".padEnd(38)} wt   items  gap  terms  attempt\n`);
  for (const domain of byDomain) {
    const attemptCell = domain.accuracy === null ? "—" : `${domain.correct}/${domain.answered} (${Math.round(domain.accuracy * 100)}%)`;
    process.stdout.write(
      `${domain.name.padEnd(38)} ${String(Math.round(domain.weight * 100)).padStart(2)}%  ${String(domain.bankedItems).padStart(3)}/${String(domain.targetItems).padStart(2)}  ${String(domain.bankGap).padStart(3)}  ${String(domain.terms).padStart(5)}  ${attemptCell}\n`,
    );
  }
  process.stdout.write(`\nBank: ${rules.length} rules, ${terms.length} terms, ${questions.length} questions\n`);
  if (defects.length > 0) {
    process.stdout.write(`\nDefects (${defects.length}):\n`);
    for (const defect of defects) process.stdout.write(`  ${defect}\n`);
  }
  if (report.attempt) {
    const a = report.attempt;
    process.stdout.write(`\nAttempt ${a.id} (${a.date}, ${a.mode}): ${a.correct}/${a.answered} raw\n`);
    process.stdout.write(`  weighted accuracy ${(a.weightedAccuracy * 100).toFixed(1)}% over ${Math.round(a.coveredWeight * 100)}% of exam weight\n`);
    process.stdout.write(`  estimated scaled ${a.estimatedScaled} vs ${passScaled} to pass (needs ${Math.round(accuracyForPass * 100)}% weighted) — estimate, not Anthropic scoring\n`);
    if (a.missedRules.length > 0) {
      process.stdout.write(`  rules to revisit: ${a.missedRules.map((id) => `${id} ${rules.find((rule) => rule.id === id).rule}`).join("; ")}\n`);
    }
  } else {
    process.stdout.write("\nNo attempts recorded. Add study/ccar-p/attempts/<id>.json to produce a readiness figure.\n");
  }
  const gaps = byDomain.filter((domain) => domain.bankGap > 0);
  if (gaps.length > 0) {
    process.stdout.write(`\nCoverage gaps vs a ${blueprint.format.items}-item exam: ${gaps.map((d) => `${d.name} needs ${d.bankGap} more`).join("; ")}\n`);
  }
}

process.exit(defects.length > 0 ? 1 : 0);
