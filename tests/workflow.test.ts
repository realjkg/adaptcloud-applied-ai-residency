import { afterEach, describe, expect, it } from "vitest";
import { runAssessment } from "../src/agent/workflow.js";
import sample from "../examples/client-intake.json" with { type: "json" };

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.MONTHLY_MODEL_BUDGET_USD;
  delete process.env.INPUT_COST_PER_MTOK;
  delete process.env.OUTPUT_COST_PER_MTOK;
});

describe("assessment workflow", () => {
  it("runs deterministically without transmitting intake", async () => {
    const result = await runAssessment(sample, new Date("2026-01-01T00:00:00.000Z"));
    expect(result.mode).toBe("deterministic");
    expect(result.findings).toHaveLength(0);
    expect(result.evidence).toEqual({ generatedAt: "2026-01-01T00:00:00.000Z", promptLogged: false });
  });

  it("rejects malformed workloads", async () => {
    await expect(runAssessment({ useCase: "short" })).rejects.toThrow();
  });

  it("raises a deterministic finding when the model budget is exceeded", async () => {
    process.env.MONTHLY_MODEL_BUDGET_USD = "0.01";
    process.env.INPUT_COST_PER_MTOK = "10";
    process.env.OUTPUT_COST_PER_MTOK = "10";
    const result = await runAssessment(sample, new Date("2026-01-01T00:00:00.000Z"));
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "COST-001", severity: "high" }));
  });
});
