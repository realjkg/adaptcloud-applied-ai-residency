import { describe, expect, it } from "vitest";
import { assessRuntimeReadiness, assertProductionReady, runtimeConfigFromEnvironment } from "../src/platform/runtime.js";

const productionEnvironment: NodeJS.ProcessEnv = {
  APP_ENV: "production",
  AUTH_MODE: "gateway",
  SECRET_SOURCE: "managed",
  AUDIT_SINK: "managed-immutable",
  TELEMETRY_EXPORTER: "otlp",
  MIN_REPLICAS: "2",
  MULTI_ZONE: "true",
  AUTOSCALING: "true",
  CARBON_AWARE_REGION: "true",
  INFRASTRUCTURE_AS_CODE: "true",
  AUTOMATIC_ROLLBACK: "true",
  BACKUP_RESTORE_TESTED: "true",
  MONTHLY_MODEL_BUDGET_USD: "2500",
  MODEL_MAX_ATTEMPTS: "2",
  REQUEST_TIMEOUT_MS: "25000"
};

describe("well-architected runtime profile", () => {
  it("recognizes the student sandbox as a distinct environment", () => {
    expect(runtimeConfigFromEnvironment({ APP_ENV: "sandbox" }).environment).toBe("sandbox");
  });

  it("fails closed when development defaults are labeled production", () => {
    const unsafe = runtimeConfigFromEnvironment({ APP_ENV: "production" });
    expect(() => assertProductionReady(unsafe)).toThrow(/SEC-001/);
    expect(assessRuntimeReadiness(unsafe).some((finding) => finding.pillar === "sustainability")).toBe(true);
  });

  it("accepts the bounded production reference profile", () => {
    const config = runtimeConfigFromEnvironment(productionEnvironment);
    expect(assessRuntimeReadiness(config)).toEqual([]);
    expect(() => assertProductionReady(config)).not.toThrow();
  });

  it("rejects unbounded or malformed operational settings", () => {
    expect(() => runtimeConfigFromEnvironment({ MODEL_MAX_ATTEMPTS: "99" })).toThrow(/MODEL_MAX_ATTEMPTS/);
    expect(() => runtimeConfigFromEnvironment({ AUTOSCALING: "sometimes" })).toThrow(/AUTOSCALING/);
  });
});
