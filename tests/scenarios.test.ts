import { beforeEach, describe, expect, it } from "vitest";
import commercial from "../examples/labs/commercial.json" with { type: "json" };
import payments from "../examples/labs/payments.json" with { type: "json" };
import insurance from "../examples/labs/insurance.json" with { type: "json" };
import { parseScenarioRequest, type ScenarioName } from "../src/scenarios/contracts.js";
import { assessScenario, isScenarioName, scenarioNames } from "../src/scenarios/registry.js";

const fixtures: Record<ScenarioName, unknown> = { commercial, payments, insurance };
const now = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe("scenario registry", () => {
  it("exposes the three scenario names and a guard", () => {
    expect(scenarioNames).toEqual(["commercial", "payments", "insurance"]);
    expect(scenarioNames.every(isScenarioName)).toBe(true);
    expect(isScenarioName("banking")).toBe(false);
    expect(isScenarioName(undefined)).toBe(false);
  });

  it.each(scenarioNames)("returns a valid envelope for the %s happy path", async (scenario) => {
    const envelope = await assessScenario(scenario, fixtures[scenario], "aws", now);
    expect(envelope.schemaVersion).toBe("1.0");
    expect(envelope.scenario).toBe(scenario);
    expect(envelope.cloud).toBe("aws");
    expect(envelope.status).toBe("ready_for_human_review");
    expect(envelope.humanApprovalRequired).toBe(true);
    expect(envelope.evidence.promptLogged).toBe(false);
    expect(envelope.evidence.sensitiveContentLogged).toBe(false);
    expect(envelope.evidence.generatedAt).toBe(now.toISOString());
    expect(envelope.evidence.model).toBeUndefined();
    expect(Array.isArray(envelope.findings)).toBe(true);
  });

  it("surfaces mode and cost at the top level of the envelope", async () => {
    const envelope = await assessScenario("payments", payments, "gcp", now);
    expect(envelope.mode).toBe("deterministic");
    expect(envelope.cost.pricingSource).toBe("environment");
    expect(typeof envelope.cost.estimatedMonthlyUsd).toBe("number");
    expect(envelope).not.toHaveProperty("architecture");
  });

  it("blocks a commercial request that asks for an external action", async () => {
    const envelope = await assessScenario(
      "commercial",
      { ...commercial, requestedActions: ["submit-work-order"] },
      "aws",
      now
    );
    expect(envelope.status).toBe("blocked");
    expect(envelope.findings).toContainEqual(expect.objectContaining({ id: "COM-ACTION" }));
    expect(envelope.humanApprovalRequired).toBe(true);
  });

  it("blocks a payments request whose ledger does not reconcile", async () => {
    const events = [...payments.events, { ...payments.events[0], type: "refund", amountMinor: 20_000, idempotencyKey: "idem-refund-200", sourceId: "evt-4" }];
    const envelope = await assessScenario("payments", { ...payments, events }, "aws", now);
    expect(envelope.status).toBe("blocked");
    expect(envelope.findings).toContainEqual(expect.objectContaining({ id: "PAY-LEDGER" }));
  });
});

describe("scenario request parsing", () => {
  const mismatches = scenarioNames.flatMap((requested) =>
    scenarioNames.filter((supplied) => supplied !== requested).map((supplied) => [requested, supplied] as const)
  );

  it.each(mismatches)("rejects the %s route when the payload declares %s", (requested, supplied) => {
    expect(() => parseScenarioRequest(requested, fixtures[supplied])).toThrow(/scenario mismatch/);
  });

  it.each(mismatches)("rejects the %s assessment when the payload declares %s", async (requested, supplied) => {
    await expect(assessScenario(requested, fixtures[supplied], "aws", now)).rejects.toThrow(/scenario mismatch/);
  });

  it.each([null, undefined, "commercial", 7, ["commercial"]])("rejects the malformed payload %s", (value) => {
    expect(() => parseScenarioRequest("commercial", value)).toThrow();
  });

  it("rejects a payload with no scenario field", () => {
    const { scenario: _scenario, ...rest } = commercial;
    expect(() => parseScenarioRequest("commercial", rest)).toThrow(/declare a scenario/);
  });

  it("rejects a missing required field", () => {
    const { assetId: _assetId, ...rest } = commercial;
    expect(() => parseScenarioRequest("commercial", rest)).toThrow(/assetId/);
    const { claimId: _claimId, ...claim } = insurance;
    expect(() => parseScenarioRequest("insurance", claim)).toThrow(/claimId/);
    const { transactionId: _transactionId, ...transaction } = payments;
    expect(() => parseScenarioRequest("payments", transaction)).toThrow(/transactionId/);
  });

  it("rejects an implicit or coerced human approval flag", () => {
    expect(() => parseScenarioRequest("commercial", { ...commercial, humanApproval: "true" })).toThrow(/explicit boolean/);
    expect(() => parseScenarioRequest("insurance", { ...insurance, humanApproval: 1 })).toThrow(/explicit boolean/);
  });

  it("rejects malformed numbers and unsupported event types", () => {
    expect(() => parseScenarioRequest("commercial", { ...commercial, laborHours: -1 })).toThrow(/laborHours/);
    expect(() => parseScenarioRequest("commercial", { ...commercial, materialCostMinor: 1.5 })).toThrow(/materialCostMinor/);
    expect(() => parseScenarioRequest("payments", { ...payments, events: [{ ...payments.events[0], type: "chargeback" }] })).toThrow(/events\[0\]\.type/);
    expect(() => parseScenarioRequest("payments", { ...payments, events: [] })).toThrow(/at least one/);
  });

  it("rejects malformed nested insurance evidence", () => {
    expect(() => parseScenarioRequest("insurance", { ...insurance, documents: [{ type: "policy-summary" }] })).toThrow(/sourceId/);
    expect(() => parseScenarioRequest("insurance", { ...insurance, facts: ["reported-loss-type"] })).toThrow(/facts\[0\]/);
  });

  it("keeps a discriminated request usable without a cast", () => {
    const request = parseScenarioRequest("insurance", insurance);
    expect(request.scenario).toBe("insurance");
    if (request.scenario !== "insurance") throw new Error("expected an insurance request");
    expect(request.documents.map((document) => document.sourceId)).toContain("doc-policy-1");
  });
});
