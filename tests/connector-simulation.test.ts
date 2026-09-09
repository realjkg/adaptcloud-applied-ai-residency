import { describe, expect, it } from "vitest";
import { mcpRefusalReasons, starterConnectorDescriptors } from "../src/platform/mcp/contracts.js";
import { buildCases, runSimulation, simulationCaveats } from "../scripts/run-connector-simulation.js";

/**
 * These tests are about the harness, not about the connector layer: a simulation that reports
 * coverage is only useful if it cannot pass vacuously, cannot silently skip an operation, and
 * computes its coverage from the exported inventory rather than from a number someone typed.
 */

const report = await runSimulation();

describe("connector simulation harness", () => {
  it("derives a case for every declared operation in the inventory", () => {
    const cases = buildCases();
    const exercised = new Set(cases.filter((item) => item.declaredOperation).map((item) => `${item.connectorId}/${item.operation}`));
    for (const descriptor of starterConnectorDescriptors) {
      for (const operation of descriptor.operations) {
        expect(exercised.has(`${descriptor.id}/${operation.name}`)).toBe(true);
      }
    }
    const declared = starterConnectorDescriptors.flatMap((descriptor) => descriptor.operations);
    expect(report.summary.operationsDeclared).toBe(declared.length);
    expect(report.summary.operationsExercised).toBe(declared.length);
  });

  it("covers every read-only operation as an allowed call and every consequential one as a refusal", () => {
    for (const descriptor of starterConnectorDescriptors) {
      for (const operation of descriptor.operations) {
        const expected = operation.operationClass === "read-only" ? "allowed" : "consequential_operation_requires_approval";
        const suffix = operation.operationClass === "read-only" ? "read-only-allowed" : "no-approval";
        const outcome = report.cases.find((item) => item.id === `${descriptor.id}/${operation.name}/${suffix}`);
        expect(outcome, `${descriptor.id}/${operation.name}`).toBeDefined();
        expect(outcome?.expected).toBe(expected);
        expect(outcome?.actual).toBe(expected);
      }
    }
  });

  it("computes refusal coverage from the exported reason list", () => {
    expect(report.summary.refusalReasonsDeclared).toBe(mcpRefusalReasons.length);
    const triggered = new Set(report.cases.map((item) => item.actual).filter((actual) => actual !== "allowed"));
    const notTriggered = mcpRefusalReasons.filter((reason) => !triggered.has(reason));
    expect(report.summary.refusalReasonsNotTriggered).toEqual(notTriggered);
    expect(report.summary.refusalReasonsTriggered).toBe(mcpRefusalReasons.length - notTriggered.length);
    // Reported coverage must be a fact about this run, not a constant.
    expect(report.summary.refusalReasonsTriggered + report.summary.refusalReasonsNotTriggered.length).toBe(
      mcpRefusalReasons.length
    );
  });

  it("holds both invariants on every case: one audit event and no canary leak", () => {
    expect(report.summary.casesRun).toBeGreaterThan(0);
    for (const outcome of report.cases) {
      expect(outcome.auditEvents, outcome.id).toBe(1);
      expect(outcome.failures, outcome.id).toEqual([]);
    }
    expect(report.summary.casesPassed).toBe(report.summary.casesRun);
    expect(report.summary.casesFailed).toBe(0);
  });

  it("fails when a single expectation is deliberately broken", async () => {
    const target = report.cases[0];
    expect(target).toBeDefined();
    const broken = await runSimulation({ breakCaseId: target?.id ?? "" });
    expect(broken.summary.casesFailed).toBe(1);
    expect(broken.summary.casesPassed).toBe(broken.summary.casesRun - 1);
    const failed = broken.cases.find((item) => !item.passed);
    expect(failed?.id).toBe(target?.id);
    expect(failed?.failures.length).toBeGreaterThan(0);
  });

  it("filters by connector without changing what the filtered run reports", async () => {
    const descriptor = starterConnectorDescriptors[0];
    expect(descriptor).toBeDefined();
    const filtered = await runSimulation({ connectorId: descriptor?.id ?? "" });
    expect(filtered.cases.every((item) => item.connectorId === descriptor?.id)).toBe(true);
    expect(filtered.summary.connectorsDeclared).toBe(1);
    expect(filtered.summary.operationsDeclared).toBe(descriptor?.operations.length);
    expect(filtered.summary.casesFailed).toBe(0);
  });

  it("is deterministic across two invocations", async () => {
    const first = await runSimulation();
    const second = await runSimulation();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(first.cases)).toBe(JSON.stringify(report.cases));
  });

  it("states what the run does not establish", () => {
    const text = simulationCaveats.join(" ");
    expect(report.caveats).toEqual(simulationCaveats);
    for (const term of ["TLS", "DNS", "redirect", "prox", "smuggling", "outage"]) {
      expect(text).toContain(term);
    }
    expect(text).not.toContain("defect-free");
  });
});
