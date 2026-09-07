import type { ControlFinding, ProjectIntake } from "./contracts.js";

export function assessControls(intake: ProjectIntake): ControlFinding[] {
  const findings: ControlFinding[] = [];
  const sensitive = intake.dataClasses.some((item) => item === "possible-pii" || item === "regulated");
  if (!intake.controls.humanApproval) findings.push({ id: "AC-001", severity: "critical", message: "Consequential output has no human approval gate.", remediation: "Require explicit approval before external or irreversible action." });
  if (sensitive && !intake.controls.piiScanning) findings.push({ id: "AC-002", severity: "high", message: "Sensitive data may reach the model without inspection.", remediation: "Add default-deny DLP/PII scanning before model ingress and tool egress." });
  if (!intake.controls.auditLogging) findings.push({ id: "AC-003", severity: "high", message: "Decisions cannot be reconstructed.", remediation: "Record immutable metadata, control outcomes, model identity, and approvals without prompt bodies." });
  if (!intake.controls.tenantIsolation) findings.push({ id: "AC-004", severity: "critical", message: "Tenant isolation is not established.", remediation: "Separate identities, storage, retrieval scope, keys, and authorization by tenant." });
  if (!intake.controls.managedSecrets) findings.push({ id: "AC-005", severity: "critical", message: "Secret custody is not managed.", remediation: "Use a managed secret store and short-lived workload identity; never expose secrets to clients." });
  return findings;
}
