export type AppEnvironment = "development" | "test" | "staging" | "production";
export type AuthMode = "none" | "gateway";
export type SecretSource = "local-environment" | "managed";
export type AuditSink = "stdout" | "managed-immutable";
export type TelemetryExporter = "console" | "otlp";

export interface RuntimeConfig {
  environment: AppEnvironment;
  authMode: AuthMode;
  secretSource: SecretSource;
  auditSink: AuditSink;
  telemetryExporter: TelemetryExporter;
  port: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
  rateLimitPerMinute: number;
  modelMaxAttempts: number;
  modelMaxOutputTokens: number;
  monthlyModelBudgetUsd: number;
  minReplicas: number;
  multiZone: boolean;
  autoscaling: boolean;
  carbonAwareRegion: boolean;
  infrastructureAsCode: boolean;
  automaticRollback: boolean;
  backupRestoreTested: boolean;
  dataRetentionDays: number;
}

export type WellArchitectedPillar =
  | "security"
  | "resilience"
  | "reliability"
  | "cost-optimization"
  | "sustainability"
  | "operational-efficiency";

export interface ReadinessFinding {
  id: string;
  pillar: WellArchitectedPillar;
  severity: "blocker" | "warning";
  message: string;
}

const environments = new Set<AppEnvironment>(["development", "test", "staging", "production"]);

function enumValue<T extends string>(value: string | undefined, fallback: T, values: readonly T[], name: string): T {
  const resolved = value ?? fallback;
  if (!values.includes(resolved as T)) throw new Error(`${name} has an unsupported value`);
  return resolved as T;
}

function integerValue(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function numberValue(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const resolved = Number(value);
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return resolved;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function runtimeConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const appEnvironment = enumValue(
    environment.APP_ENV,
    "development",
    [...environments],
    "APP_ENV"
  );
  return {
    environment: appEnvironment,
    authMode: enumValue(environment.AUTH_MODE, "none", ["none", "gateway"], "AUTH_MODE"),
    secretSource: enumValue(environment.SECRET_SOURCE, "local-environment", ["local-environment", "managed"], "SECRET_SOURCE"),
    auditSink: enumValue(environment.AUDIT_SINK, "stdout", ["stdout", "managed-immutable"], "AUDIT_SINK"),
    telemetryExporter: enumValue(environment.TELEMETRY_EXPORTER, "console", ["console", "otlp"], "TELEMETRY_EXPORTER"),
    port: integerValue(environment.PORT, 3000, 1, 65_535, "PORT"),
    requestTimeoutMs: integerValue(environment.REQUEST_TIMEOUT_MS, 30_000, 1_000, 60_000, "REQUEST_TIMEOUT_MS"),
    maxConcurrentRequests: integerValue(environment.MAX_CONCURRENT_REQUESTS, 20, 1, 10_000, "MAX_CONCURRENT_REQUESTS"),
    rateLimitPerMinute: integerValue(environment.RATE_LIMIT_PER_MINUTE, 60, 1, 1_000_000, "RATE_LIMIT_PER_MINUTE"),
    modelMaxAttempts: integerValue(environment.MODEL_MAX_ATTEMPTS, 1, 1, 3, "MODEL_MAX_ATTEMPTS"),
    modelMaxOutputTokens: integerValue(environment.MODEL_MAX_OUTPUT_TOKENS, 700, 1, 4_096, "MODEL_MAX_OUTPUT_TOKENS"),
    monthlyModelBudgetUsd: numberValue(environment.MONTHLY_MODEL_BUDGET_USD, 0, 0, 100_000_000, "MONTHLY_MODEL_BUDGET_USD"),
    minReplicas: integerValue(environment.MIN_REPLICAS, 1, 1, 100, "MIN_REPLICAS"),
    multiZone: booleanValue(environment.MULTI_ZONE, false, "MULTI_ZONE"),
    autoscaling: booleanValue(environment.AUTOSCALING, false, "AUTOSCALING"),
    carbonAwareRegion: booleanValue(environment.CARBON_AWARE_REGION, false, "CARBON_AWARE_REGION"),
    infrastructureAsCode: booleanValue(environment.INFRASTRUCTURE_AS_CODE, false, "INFRASTRUCTURE_AS_CODE"),
    automaticRollback: booleanValue(environment.AUTOMATIC_ROLLBACK, false, "AUTOMATIC_ROLLBACK"),
    backupRestoreTested: booleanValue(environment.BACKUP_RESTORE_TESTED, false, "BACKUP_RESTORE_TESTED"),
    dataRetentionDays: integerValue(environment.DATA_RETENTION_DAYS, 7, 1, 365, "DATA_RETENTION_DAYS")
  };
}

export function assessRuntimeReadiness(config: RuntimeConfig): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const add = (condition: boolean, finding: ReadinessFinding): void => {
    if (!condition) findings.push(finding);
  };

  add(config.authMode === "gateway", { id: "SEC-001", pillar: "security", severity: "blocker", message: "Production ingress must authenticate at a trusted gateway." });
  add(config.secretSource === "managed", { id: "SEC-002", pillar: "security", severity: "blocker", message: "Production secrets must come from a managed secret store or workload identity." });
  add(config.auditSink === "managed-immutable", { id: "SEC-003", pillar: "security", severity: "blocker", message: "Audit metadata must be exported to an immutable managed sink." });
  add(config.minReplicas >= 2 && config.multiZone, { id: "RES-001", pillar: "resilience", severity: "blocker", message: "Run at least two replicas across failure zones." });
  add(config.backupRestoreTested, { id: "RES-002", pillar: "resilience", severity: "blocker", message: "A restore drill must prove the recovery path before promotion." });
  add(config.telemetryExporter === "otlp", { id: "REL-001", pillar: "reliability", severity: "blocker", message: "Export metrics, traces, and metadata-only logs to managed observability." });
  add(config.automaticRollback, { id: "REL-002", pillar: "reliability", severity: "blocker", message: "Deployments must automatically roll back on failed health or SLO gates." });
  add(config.monthlyModelBudgetUsd > 0, { id: "COST-001", pillar: "cost-optimization", severity: "blocker", message: "Set an explicit monthly model budget." });
  add(config.rateLimitPerMinute > 0 && config.modelMaxOutputTokens <= 4_096, { id: "COST-002", pillar: "cost-optimization", severity: "blocker", message: "Bound request rate and model output." });
  add(config.autoscaling, { id: "SUS-001", pillar: "sustainability", severity: "blocker", message: "Enable demand-based autoscaling to avoid idle capacity." });
  add(config.carbonAwareRegion, { id: "SUS-002", pillar: "sustainability", severity: "warning", message: "Document the carbon and data-residency tradeoff used to select the deployment region." });
  add(config.infrastructureAsCode, { id: "OPS-001", pillar: "operational-efficiency", severity: "blocker", message: "Provision production resources with reviewed infrastructure as code." });
  add(config.requestTimeoutMs <= 30_000 && config.modelMaxAttempts <= 3, { id: "OPS-002", pillar: "operational-efficiency", severity: "blocker", message: "Keep timeouts and retries bounded to prevent retry storms." });
  return findings;
}

export function assertProductionReady(config: RuntimeConfig): void {
  if (config.environment !== "production") return;
  const blockers = assessRuntimeReadiness(config).filter((finding) => finding.severity === "blocker");
  if (blockers.length > 0) throw new Error(`production_readiness_failed:${blockers.map((finding) => finding.id).join(",")}`);
}
