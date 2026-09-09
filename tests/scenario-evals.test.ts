import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runLabSimulation, type CloudTarget, type LabInput, type LabScenario } from "../src/labs/simulator.js";

interface ScenarioEvalCase {
  name: string;
  scenario: LabScenario;
  input: string | unknown;
  cloud?: CloudTarget;
  expectedStatus: "ready_for_human_review" | "blocked";
  expectedFindings: string[];
}

// The evaluations are a deterministic contract; no local model configuration may reach them.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;

const SCENARIOS: LabScenario[] = ["commercial", "payments", "insurance"];
const PREFIX: Record<LabScenario, string> = { commercial: "COM-", payments: "PAY-", insurance: "INS-" };
const cases = JSON.parse(readFileSync("evals/scenario-cases.json", "utf8")) as ScenarioEvalCase[];

// Read the ids straight from the policy so a new refusal cannot be added without an evaluation.
const simulatorSource = readFileSync("src/labs/simulator.ts", "utf8");
const policyFindingIds = [...simulatorSource.matchAll(/finding\("([A-Z]+-[A-Z]+)"/g)].map((match) => match[1] ?? "");
const idsForScenario = (scenario: LabScenario): string[] => policyFindingIds.filter((id) => id.startsWith(PREFIX[scenario]));

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const minorAmounts = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.flatMap(minorAmounts);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      key.endsWith("Minor") ? (typeof item === "number" ? [item] : [Number.NaN]) : minorAmounts(item));
  }
  return [];
};

describe("scenario evaluation case file", () => {
  it("names a supported scenario in every case and uses unique case names", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) expect(SCENARIOS).toContain(item.scenario);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
  });

  it("expects only finding ids the scenario's policy can raise", () => {
    expect(policyFindingIds.length).toBeGreaterThan(0);
    for (const item of cases) {
      for (const id of item.expectedFindings) expect(idsForScenario(item.scenario)).toContain(id);
    }
  });

  it("states a blocked status exactly when it expects a blocking finding", () => {
    for (const item of cases) {
      expect(item.expectedStatus).toBe(item.expectedFindings.length > 0 ? "blocked" : "ready_for_human_review");
    }
  });

  it("covers every scenario with a happy path and adversarial free-text case", () => {
    for (const scenario of SCENARIOS) {
      const scoped = cases.filter((item) => item.scenario === scenario);
      expect(scoped.some((item) => item.expectedStatus === "ready_for_human_review")).toBe(true);
      expect(scoped.some((item) => /adversarial/i.test(item.name))).toBe(true);
    }
  });

  it("carries money as non-negative integer minor units with an explicit currency", () => {
    for (const item of cases) {
      if (typeof item.input === "string") continue;
      for (const amount of minorAmounts(item.input)) expect(Number.isSafeInteger(amount) && amount >= 0).toBe(true);
      const input = item.input as { currency?: unknown };
      if (item.scenario !== "insurance") expect(typeof input.currency).toBe("string");
    }
  });

  it("covers every blocking finding the simulator can raise", () => {
    const covered = new Set(cases.flatMap((item) => item.expectedFindings));
    for (const id of policyFindingIds) expect([...covered]).toContain(id);
  });
});

describe("scenario evaluation outcomes", () => {
  for (const item of cases) {
    it(`${item.scenario}: ${item.name}`, async () => {
      const input = (typeof item.input === "string" ? JSON.parse(readFileSync(item.input, "utf8")) : item.input) as LabInput;
      const result = await runLabSimulation(input, item.cloud ?? "aws", new Date("2026-01-01T00:00:00.000Z"));
      expect(result.status).toBe(item.expectedStatus);
      expect(sorted(result.findings.filter((f) => f.id.startsWith(PREFIX[item.scenario])).map((f) => f.id))).toEqual(sorted(item.expectedFindings));
    });
  }
});
