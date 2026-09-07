import { afterEach, describe, expect, it, vi } from "vitest";
import { requestArchitectureRecommendation } from "../src/agent/claude.js";
import type { CostEstimate, ProjectIntake } from "../src/agent/contracts.js";

const intake: ProjectIntake = {
  useCase: "Synthetic bounded architecture assessment",
  industry: "technology",
  dataClasses: ["public"],
  monthlyRequests: 10,
  averageInputTokens: 100,
  averageOutputTokens: 50,
  controls: { humanApproval: true, piiScanning: true, auditLogging: true, tenantIsolation: true, managedSecrets: true }
};
const cost: CostEstimate = { monthlyInputTokens: 1_000, monthlyOutputTokens: 500, estimatedMonthlyUsd: 1, pricingSource: "environment" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.MODEL_MAX_ATTEMPTS;
});

describe("bounded Claude adapter", () => {
  it("falls back without throwing when the provider is unavailable", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider unavailable")));
    await expect(requestArchitectureRecommendation(intake, cost)).resolves.toBeUndefined();
  });

  it("retries a transient response only within the configured bound", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    process.env.MODEL_MAX_ATTEMPTS = "2";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "Bounded recommendation" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestArchitectureRecommendation(intake, cost)).resolves.toBe("Bounded recommendation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
