import { afterEach, describe, expect, it, vi } from "vitest";
import { maxToolCallsPerExchange } from "../src/agent/tools.js";
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

  it("returns nothing when the provider answers with malformed or empty content", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    for (const body of ['{"unexpected":true}', '{"content":[]}', '{"content":[{"type":"text","text":"   "}]}', "not json at all"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      await expect(requestArchitectureRecommendation(intake, cost)).resolves.toBeUndefined();
    }
  });

  it("offers only read-only tools and never sends prompt content in a tool definition", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await requestArchitectureRecommendation(intake, cost);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as { tools: Array<{ name: string }> };
    expect(body.tools.map((tool) => tool.name).sort()).toEqual([
      "assess_controls", "check_promotion_gates", "check_runtime_readiness", "estimate_token_cost"
    ]);
  });

  it("answers a tool request with a deterministic result and then returns the recommendation", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "call-1", name: "assess_controls", input: { dataClasses: ["regulated"], controls: intake.controls } }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "Grounded recommendation" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestArchitectureRecommendation(intake, cost)).resolves.toBe("Grounded recommendation");
    const second = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body) as { messages: Array<{ role: string; content: unknown }> };
    const toolResult = (second.messages[2]?.content as Array<{ type: string; tool_use_id: string; is_error: boolean }>)[0];
    expect(toolResult?.type).toBe("tool_result");
    expect(toolResult?.tool_use_id).toBe("call-1");
    expect(toolResult?.is_error).toBe(false);
  });

  it("stops a model that only ever asks for tools instead of looping without bound", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    // A fresh Response per call: a body may only be read once, so a shared instance would
    // fail the second read and end the loop for the wrong reason.
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call-loop", name: "check_runtime_readiness", input: {} }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestArchitectureRecommendation(intake, cost)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(maxToolCallsPerExchange + 1);
  });

  it("refuses an unknown tool as data rather than failing the request", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "call-x", name: "delete_everything", input: { path: "/" } }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "Recovered" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestArchitectureRecommendation(intake, cost)).resolves.toBe("Recovered");
    const second = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body) as { messages: Array<{ content: unknown }> };
    const toolResult = (second.messages[2]?.content as Array<{ is_error: boolean; content: string }>)[0];
    expect(toolResult?.is_error).toBe(true);
    expect(toolResult?.content).toContain("refused");
  });
});
