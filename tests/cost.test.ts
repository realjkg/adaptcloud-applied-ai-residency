import { describe, expect, it } from "vitest";
import { estimateMonthlyCost } from "../src/agent/cost.js";
import { validateIntake } from "../src/agent/validate.js";
import sample from "../examples/client-intake.json" with { type: "json" };

describe("token cost", () => {
  it("uses explicit per-million-token prices", () => {
    const result = estimateMonthlyCost(validateIntake(sample), { inputPerMillion: 3, outputPerMillion: 15 });
    expect(result.monthlyInputTokens).toBe(28_800_000);
    expect(result.monthlyOutputTokens).toBe(7_800_000);
    expect(result.estimatedMonthlyUsd).toBe(203.4);
  });
});
