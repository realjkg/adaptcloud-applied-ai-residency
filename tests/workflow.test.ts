import { afterEach, describe, expect, it } from "vitest";
import { runAssessment } from "../src/agent/workflow.js";
import sample from "../examples/client-intake.json" with { type: "json" };

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
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
});
