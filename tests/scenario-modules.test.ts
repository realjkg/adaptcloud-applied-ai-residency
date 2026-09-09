import { describe, expect, it } from "vitest";
import commercial from "../examples/labs/commercial.json" with { type: "json" };
import payments from "../examples/labs/payments.json" with { type: "json" };
import insurance from "../examples/labs/insurance.json" with { type: "json" };
import { policyFindingIds } from "../src/labs/simulator.js";
import { commercialModule } from "../src/scenarios/commercial.js";
import { insuranceModule } from "../src/scenarios/insurance.js";
import { paymentsModule } from "../src/scenarios/payments.js";
import { scenarioModules } from "../src/scenarios/registry.js";
import type { ScenarioModule, ScenarioName } from "../src/scenarios/contracts.js";

// Every claim about a scenario is proved by running its own policy, never by reading source text.
const cases: Record<ScenarioName, unknown[]> = {
  commercial: [
    commercial,
    { ...commercial, humanApproval: false },
    { ...commercial, requestedActions: ["submit-work-order"] },
    { ...commercial, requestedActions: ["schedule-labor", "purchase-material", "contact-vendor"] },
    { ...commercial, humanApproval: false, requestedActions: ["submit-work-order"] },
    { ...commercial, downtimeHours: 0, laborHours: 0, materialCostMinor: 0 }
  ],
  payments: [
    payments,
    { ...payments, humanApproval: false },
    { ...payments, events: [...payments.events, { ...payments.events[1], sourceId: "evt-4" }] },
    { ...payments, events: [...payments.events, { ...payments.events[2], type: "refund", amountMinor: 99_900, idempotencyKey: "idem-refund-200", sourceId: "evt-5" }] },
    { ...payments, events: [{ ...payments.events[0], currency: "EUR" }, ...payments.events.slice(1)] },
    { ...payments, humanApproval: false, events: [{ ...payments.events[0], currency: "EUR" }] }
  ],
  insurance: [
    insurance,
    { ...insurance, humanApproval: false },
    { ...insurance, documents: [] },
    { ...insurance, documents: [insurance.documents[0]] },
    { ...insurance, facts: [...insurance.facts, { name: "injected", value: "x", sourceId: "doc-unknown" }] },
    { ...insurance, humanApproval: false, documents: [], facts: insurance.facts }
  ]
};

const modules = [commercialModule, paymentsModule, insuranceModule] as const;
const prefix: Record<ScenarioName, string> = { commercial: "COM-", payments: "PAY-", insurance: "INS-" };
const assertionKeys = ["externalActionTaken", "fundsMoved", "fraudDecisionMade", "narrativeLogged", "coverageDetermined", "liabilityDetermined", "paymentAuthorized"];

type AnyScenarioModule = ScenarioModule<ScenarioName, unknown>;

const evaluate = (module: (typeof modules)[number], raw: unknown) => {
  const scoped = module as unknown as AnyScenarioModule;
  return scoped.policy(scoped.parse(raw as Record<string, unknown>));
};

const raisedIds = (module: (typeof modules)[number]): Set<string> => {
  const ids = new Set<string>();
  for (const raw of cases[module.name]) for (const item of evaluate(module, raw).findings) ids.add(item.id);
  return ids;
};

const durationMinutes = (value: string): number => {
  const match = /^(\d+) (minutes?|hours?)$/.exec(value);
  if (!match) throw new Error(`unparsable duration: ${value}`);
  return Number(match[1]) * (match[2]!.startsWith("hour") ? 60 : 1);
};

describe("scenario modules", () => {
  it("registers exactly the three scenario modules once each", () => {
    expect(scenarioModules.map((module) => module.name)).toEqual(["commercial", "payments", "insurance"]);
    expect(new Set(scenarioModules.map((module) => module.name)).size).toBe(scenarioModules.length);
  });

  it.each(modules)("declares $name finding ids that are unique and scenario-scoped", (module) => {
    expect(module.findingIds.length).toBeGreaterThan(0);
    expect(new Set(module.findingIds).size).toBe(module.findingIds.length);
    for (const id of module.findingIds) expect(id.startsWith(prefix[module.name])).toBe(true);
  });

  it.each(modules)("declares exactly the finding ids the $name policy can raise", (module) => {
    const raised = [...raisedIds(module)].sort();
    expect(raised).toEqual([...module.findingIds].sort());
  });

  it("keeps the simulator's scraped roster equal to the declared module ids", () => {
    expect([...policyFindingIds].sort()).toEqual(modules.flatMap((module) => [...module.findingIds]).sort());
  });

  it.each(modules)("states a coherent operating envelope for $name", (module) => {
    const envelope = module.envelope;
    for (const value of Object.values(envelope)) expect(value.trim().length).toBeGreaterThan(0);
    const availability = Number(envelope.availabilityTarget.replace("%", ""));
    expect(availability).toBeGreaterThanOrEqual(99);
    expect(availability).toBeLessThan(100);
    expect(durationMinutes(envelope.recoveryTimeObjective)).toBeGreaterThan(0);
    expect(durationMinutes(envelope.recoveryPointObjective)).toBeGreaterThan(0);
    expect(envelope.costUnit.startsWith("cost per ")).toBe(true);
  });

  it("gives the stricter availability target the tighter recovery objectives", () => {
    const ranked = [...modules].sort((a, b) => Number(b.envelope.availabilityTarget.replace("%", "")) - Number(a.envelope.availabilityTarget.replace("%", "")));
    for (let index = 1; index < ranked.length; index += 1) {
      const stricter = ranked[index - 1]!.envelope;
      const looser = ranked[index]!.envelope;
      // Scenarios that share an availability target are free to differ on recovery objectives.
      if (stricter.availabilityTarget === looser.availabilityTarget) continue;
      expect(durationMinutes(stricter.recoveryTimeObjective)).toBeLessThanOrEqual(durationMinutes(looser.recoveryTimeObjective));
      expect(durationMinutes(stricter.recoveryPointObjective)).toBeLessThanOrEqual(durationMinutes(looser.recoveryPointObjective));
    }
  });

  it.each(modules)("never lets the $name policy assert a consequential action", (module) => {
    for (const raw of cases[module.name]) {
      const { domain } = evaluate(module, raw);
      for (const key of assertionKeys) {
        if (key in domain) expect(domain[key]).toBe(false);
      }
    }
  });

  it("keeps the whole assertion key set represented across the three modules", () => {
    const observed = new Set(modules.flatMap((module) => Object.keys(evaluate(module, cases[module.name][0]).domain)));
    for (const key of assertionKeys) expect([...observed]).toContain(key);
  });
});
