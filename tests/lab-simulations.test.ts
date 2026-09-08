import { afterEach, describe, expect, it, vi } from "vitest";
import { runLabSimulation, type LabInput } from "../src/labs/simulator.js";
import commercial from "../examples/labs/commercial.json" with { type: "json" };
import payments from "../examples/labs/payments.json" with { type: "json" };
import insurance from "../examples/labs/insurance.json" with { type: "json" };

const fixtures = [commercial, payments, insurance] as LabInput[];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("end-to-end lab simulations", () => {
  it.each(["aws", "gcp"] as const)("runs all three bounded scenarios for %s", async (cloud) => {
    const results = await Promise.all(fixtures.map((fixture) => runLabSimulation(fixture, cloud, new Date("2026-01-01T00:00:00.000Z"))));
    expect(results.map((result) => result.scenario)).toEqual(["commercial", "payments", "insurance"]);
    expect(results.every((result) => result.status === "ready_for_human_review")).toBe(true);
    expect(results.every((result) => result.architecture.mode === "deterministic")).toBe(true);
    expect(results.every((result) => result.evidence.terraformRoot === `infra/${cloud}`)).toBe(true);
  });

  it("uses the Claude adapter without sending an insurance narrative", async () => {
    process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
    process.env.ANTHROPIC_MODEL = "synthetic-model";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "Human-supervised architecture" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runLabSimulation({ ...insurance, narrative: "DO-NOT-TRANSMIT-NARRATIVE" } as LabInput, "gcp");
    expect(result.architecture.mode).toBe("claude-assisted");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("DO-NOT-TRANSMIT-NARRATIVE");
    expect(JSON.stringify(result)).not.toContain("DO-NOT-TRANSMIT-NARRATIVE");
  });

  it("blocks prohibited commercial actions", async () => {
    const result = await runLabSimulation({ ...commercial, requestedActions: ["purchase-material"] } as LabInput, "aws");
    expect(result.status).toBe("blocked");
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "COM-ACTION" }));
  });

  it("blocks duplicate and imbalanced payment evidence", async () => {
    const events = [...payments.events, { ...payments.events[1]!, amountMinor: 1 }];
    const result = await runLabSimulation({ ...payments, events } as LabInput, "aws");
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "PAY-IDEMPOTENCY" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "PAY-LEDGER" }));
  });

  it("preserves missing insurance evidence and provenance failures", async () => {
    const result = await runLabSimulation({ ...insurance, documents: [], facts: insurance.facts } as LabInput, "gcp");
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "INS-EVIDENCE" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ id: "INS-PROVENANCE" }));
  });
});
