import { describe, expect, it } from "vitest";
import { assessControls } from "../src/agent/governance.js";
import { validateIntake } from "../src/agent/validate.js";
import sample from "../examples/client-intake.json" with { type: "json" };

describe("governance controls", () => {
  it("accepts the bounded sample control profile", () => {
    expect(assessControls(validateIntake(sample))).toEqual([]);
  });

  it("fails closed when consequential approval is absent", () => {
    const findings = assessControls(validateIntake({ ...sample, controls: { ...sample.controls, humanApproval: false } }));
    expect(findings).toContainEqual(expect.objectContaining({ id: "AC-001", severity: "critical" }));
  });
});
