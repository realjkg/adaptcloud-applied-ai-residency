#!/usr/bin/env node
// Render the CCAR-P study guide from study/ccar-p so the document and the bank cannot drift.
// The bank is the source of truth; this file only formats it.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();
const bankDir = resolve(repoRoot, "study/ccar-p");
const out = process.argv.slice(2).find((arg) => arg.startsWith("--out="))?.split("=")[1];

const readJsonl = (name) =>
  readFileSync(join(bankDir, name), "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));

const blueprint = JSON.parse(readFileSync(join(bankDir, "blueprint.json"), "utf8"));
const rules = readJsonl("rules.jsonl");
const terms = readJsonl("terminology.jsonl");
const questions = readJsonl("questions.jsonl");
const digest = createHash("sha256")
  .update(["blueprint.json", "rules.jsonl", "terminology.jsonl", "questions.jsonl"].map((name) => readFileSync(join(bankDir, name))).join("\n"))
  .digest("hex")
  .slice(0, 12);

const ruleText = (id) => rules.find((rule) => rule.id === id)?.rule ?? id;
const lines = [];
const w = (line = "") => lines.push(line);

w(`# ${blueprint.exam} (${blueprint.code})`);
w();
w("**Derived study guide and practice bank. This is not official Anthropic content and contains no recalled exam items.**");
w();
w(`Every question and definition below is original material written from public Claude documentation and from the controls in the adaptcloud-applied-ai-residency repository. The domain weights are transcribed from a third-party reproduction of Anthropic's Exam Guide v1.0 and are marked **${blueprint.provenance.status}** — if your Anthropic Academy candidate guide lists different weights or exclusions, that document is authoritative and this one is the companion.`);
w();
w(`Bank digest \`${digest}\` — ${rules.length} decision rules, ${terms.length} terms, ${questions.length} practice items. Generated from \`study/ccar-p/\` by \`scripts/build-study-guide.mjs\`.`);
w();
w("## What Professional adds over Foundations");
w();
w("The Foundations guide teaches the design instincts. Professional asks whether you can own the system afterwards: defend the decision to a stakeholder, keep it compliant through its lifecycle, and connect it to the enterprise systems it has to live inside. Three domains carry that difference — Governance/Safety/Risk, Stakeholder Communication/Lifecycle, and Developer Productivity/Enablement — and the first two are 28% of the exam combined. Technical candidates lose marks there, not in Integration.");
w();
w("## Exam blueprint");
w();
w(`${blueprint.format.items} items, ${blueprint.format.minutes} minutes, scaled ${blueprint.format.scaleMin}–${blueprint.format.scaleMax}, ${blueprint.format.passScaled} to pass. Multiple choice and multiple response.`);
w();
w("| Domain | Weight | Items (approx.) | Terms here | Items here |");
w("|---|---|---|---|---|");
for (const domain of blueprint.domains) {
  const target = Math.round(domain.weight * blueprint.format.items);
  const t = terms.filter((term) => term.d === domain.id).length;
  const q = questions.filter((question) => question.d === domain.id).length;
  w(`| ${domain.name} | ${Math.round(domain.weight * 100)}% | ${target} | ${t} | ${q} |`);
}
w();
w("Study time is allocated by weight, not by comfort. The two heaviest domains, Integration and Solution Design, are a third of the exam between them; Developer Productivity is 7% and does not deserve a weekend.");
w();
w("## How to use this guide");
w();
w("1. Read the terminology once for vocabulary, not memorization. Each term names the rule it serves and the control in the repository that implements it — if you can point at the code, you understand the term.");
w("2. Memorize the 25 decision rules. They are phrased as scenario-answering shortcuts because that is what the exam rewards.");
w("3. Work the practice items. A guessed correct answer is not mastery: you should be able to say why each wrong option is wrong, and the trap line tells you which wrong option was built to be attractive.");
w("4. Record each attempt as a file in `study/ccar-p/attempts/` and run `npm run study:readiness`. The script grades against the bank, weights by domain, and names the rules behind every miss.");
w("5. Revisit only the sections tied to missed rules, then retake after a sleep cycle rather than memorizing answer order.");
w();
w("## Part A — Terminology");
w();
for (const domain of blueprint.domains) {
  const group = terms.filter((term) => term.d === domain.id);
  if (group.length === 0) continue;
  w(`### ${domain.name} (${Math.round(domain.weight * 100)}%)`);
  w();
  for (const term of group) {
    const refs = (term.rules ?? []).map((id) => `${id}`).join(", ");
    w(`**${term.term}** — ${term.def}`);
    w();
    w(`*Rules: ${refs} · In this repo: ${term.evidence}*`);
    w();
  }
}
w("## Part B — The 25 architect decision rules");
w();
w("| # | Rule | Domain | Implemented here as |");
w("|---|---|---|---|");
for (const rule of rules) {
  const domain = blueprint.domains.find((entry) => entry.id === rule.d);
  w(`| ${rule.id} | ${rule.rule} | ${domain.name} | \`${rule.evidence}\` |`);
}
w();
w("## Part C — Practice items");
w();
w("Choose the best architecture answer, not merely one that could work in a demo.");
w();
for (const domain of blueprint.domains) {
  const group = questions.filter((question) => question.d === domain.id);
  if (group.length === 0) continue;
  w(`### ${domain.name}`);
  w();
  for (const question of group) {
    w(`**${question.id}. ${question.stem}**`);
    w();
    for (const [key, text] of Object.entries(question.opts)) w(`- ${key}. ${text}`);
    w();
    w(`**Answer: ${question.ans}** — ${question.why}`);
    if (question.trap) w(`*Trap:* ${question.trap}`);
    w(`*Rules: ${(question.rules ?? []).map((id) => `${id} ${ruleText(id)}`).join("; ")}*`);
    w();
  }
}
w("## Part D — Readiness evidence, not a feeling");
w();
w("An attempt is a JSON file recording the option chosen per question id. The script grades it against the bank, so a score cannot be self-reported:");
w();
w("```json");
w('{ "id": "2026-09-26-closed-book", "date": "2026-09-26", "mode": "closed-book timed",');
w('  "responses": { "q01": "B", "q02": "A" } }');
w("```");
w();
w("`npm run study:readiness` then reports per-domain accuracy, weighted accuracy over the share of exam weight the attempt actually covered, an estimated scaled score, the rules behind every miss, and the bank digest.");
w();
w("**Quote the digest with any readiness figure.** A score from a bank that has since changed is not evidence of anything — the same reason promotion evidence in this repository ties every stage to one artifact digest.");
w();
w("**What the estimate is not.** It is a linear map from weighted accuracy onto the 100–1000 scale. Anthropic does not publish its scoring model and this bank is not the exam. Use it to find weak domains and to decide when to sit the exam; do not report it as a predicted result.");
w();
w("## Part E — Known gaps in this bank");
w();
const gaps = blueprint.domains
  .map((domain) => ({ domain, gap: Math.round(domain.weight * blueprint.format.items) - questions.filter((q) => q.d === domain.id).length }))
  .filter((entry) => entry.gap > 0);
w(`This bank holds ${questions.length} items against a ${blueprint.format.items}-item exam. To reach one full weighted mock it needs:`);
w();
for (const entry of gaps) w(`- ${entry.domain.name}: ${entry.gap} more items`);
w();
w("Add official material by appending to `questions.jsonl` and `terminology.jsonl` with stable new ids; nothing existing changes and the digest moves to reflect it. Record official items by reference rather than pasting copyrighted exam content.");
w();

const markdown = `${lines.join("\n")}\n`;
if (out) writeFileSync(resolve(repoRoot, out), markdown);
else process.stdout.write(markdown);
