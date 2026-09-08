import { describe, expect, it } from "vitest";
import { evaluateInfrastructureGuard } from "../scripts/guard-infrastructure.mjs";

describe("student-owned infrastructure mutation guard", () => {
  it.each(["sandbox", "qa", "staging", "production"])("allows a reviewed %s plan", (environment) => {
    expect(evaluateInfrastructureGuard(environment, "plan").allowed).toBe(true);
  });

  it.each([
    ["apply", "APPLY MY SANDBOX"],
    ["destroy", "DESTROY MY SANDBOX"]
  ])("allows confirmed sandbox %s", (operation, confirmation) => {
    expect(evaluateInfrastructureGuard("sandbox", operation, confirmation).allowed).toBe(true);
  });

  it.each(["qa", "staging", "production"])("rejects every %s mutation", (environment) => {
    expect(evaluateInfrastructureGuard(environment, "apply", "APPLY MY SANDBOX").allowed).toBe(false);
    expect(evaluateInfrastructureGuard(environment, "destroy", "DESTROY MY SANDBOX").allowed).toBe(false);
  });

  it("rejects missing, misspelled, and cross-operation confirmations", () => {
    expect(evaluateInfrastructureGuard("sandbox", "apply").allowed).toBe(false);
    expect(evaluateInfrastructureGuard("sandbox", "apply", "apply my sandbox").allowed).toBe(false);
    expect(evaluateInfrastructureGuard("sandbox", "apply", "DESTROY MY SANDBOX").allowed).toBe(false);
    expect(evaluateInfrastructureGuard("sandbox", "destroy", "APPLY MY SANDBOX").allowed).toBe(false);
  });

  it("fails closed for unknown environments and operations", () => {
    expect(evaluateInfrastructureGuard("development", "apply", "APPLY MY SANDBOX").allowed).toBe(false);
    expect(evaluateInfrastructureGuard("sandbox", "promote", "APPLY MY SANDBOX").allowed).toBe(false);
  });
});
