export type DataClass = "public" | "internal" | "possible-pii" | "regulated";

export interface ControlProfile {
  humanApproval: boolean;
  piiScanning: boolean;
  auditLogging: boolean;
  tenantIsolation: boolean;
  managedSecrets: boolean;
}

export interface ProjectIntake {
  useCase: string;
  industry: string;
  dataClasses: DataClass[];
  monthlyRequests: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  controls: ControlProfile;
}

export interface CostEstimate {
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  estimatedMonthlyUsd: number;
  pricingSource: "environment";
}

export interface ControlFinding {
  id: string;
  severity: "critical" | "high" | "medium";
  message: string;
  remediation: string;
}

export interface Assessment {
  mode: "deterministic" | "claude-assisted";
  cost: CostEstimate;
  findings: ControlFinding[];
  recommendation: string;
  evidence: {
    generatedAt: string;
    model?: string;
    promptLogged: false;
  };
}
