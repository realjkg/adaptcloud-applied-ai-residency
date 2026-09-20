import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bankDir = "study/ccar-p";

const readJsonl = <T>(name: string): T[] =>
  readFileSync(join(bankDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);

interface Domain { id: string; name: string; weight: number }
interface Rule { id: string; rule: string; d: string; evidence: string }
interface Term { id: string; term: string; d: string; def: string; rules: string[]; evidence: string }
interface Question { id: string; d: string; src: string; stem: string; opts: Record<string, string>; ans: string; why: string; rules: string[] }

const blueprint = JSON.parse(readFileSync(join(bankDir, "blueprint.json"), "utf8")) as {
  format: { items: number; passScaled: number; scaleMin: number; scaleMax: number };
  provenance: { status: string };
  domains: Domain[];
};
const rules = readJsonl<Rule>("rules.jsonl");
const terms = readJsonl<Term>("terminology.jsonl");
const questions = readJsonl<Question>("questions.jsonl");

const run = (args: string[] = []) => spawnSync("node", ["scripts/study-readiness.mjs", ...args], { encoding: "utf8" });

describe("CCAR-P study bank", () => {
  it("weights the seven domains to a whole exam", () => {
    expect(blueprint.domains).toHaveLength(7);
    const total = blueprint.domains.reduce((sum, domain) => sum + domain.weight, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("keeps every term and question pointed at a real domain and rule", () => {
    const domainIds = new Set(blueprint.domains.map((domain) => domain.id));
    const ruleIds = new Set(rules.map((rule) => rule.id));
    for (const record of [...terms, ...questions]) {
      expect(domainIds).toContain(record.d);
      for (const rule of record.rules) expect(ruleIds).toContain(rule);
    }
    for (const rule of rules) expect(domainIds).toContain(rule.d);
  });

  it("gives every question an answer that is one of its own options", () => {
    for (const question of questions) {
      expect(Object.keys(question.opts)).toContain(question.ans);
      expect(question.why.length).toBeGreaterThan(0);
    }
  });

  it("keeps ids unique so an attempt cannot address two records", () => {
    for (const records of [rules, terms, questions]) {
      const ids = records.map((record) => record.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("carries no unverified blueprint silently", () => {
    // The status is allowed to be unverified; it is not allowed to be absent.
    expect(["unverified", "verified"]).toContain(blueprint.provenance.status);
  });

  it("holds no recalled exam items", () => {
    for (const question of questions) expect(["derived", "official-reference"]).toContain(question.src);
  });

  it("reports coverage and grades the example attempt deterministically", () => {
    const first = run(["--json"]);
    expect(first.status).toBe(0);
    const report = JSON.parse(first.stdout) as {
      defects: string[];
      digest: string;
      attempt: { answered: number; correct: number; estimatedScaled: number } | null;
    };
    expect(report.defects).toEqual([]);
    expect(report.attempt?.answered).toBe(questions.length);
    expect(report.attempt?.estimatedScaled).toBeGreaterThan(blueprint.format.scaleMin);

    const second = JSON.parse(run(["--json"]).stdout) as { digest: string };
    expect(second.digest).toBe(report.digest);
  });
});
