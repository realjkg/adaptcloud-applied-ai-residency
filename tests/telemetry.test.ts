import { describe, expect, it } from "vitest";
import { traceEndpointFromEnvironment } from "../src/platform/telemetry.js";

describe("OpenTelemetry endpoint contract", () => {
  it("uses the local collector endpoint by default", () => {
    expect(traceEndpointFromEnvironment({})).toBe("http://127.0.0.1:4318/v1/traces");
  });

  it("normalizes a shared OTLP endpoint", () => {
    expect(traceEndpointFromEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" }))
      .toBe("http://collector:4318/v1/traces");
  });

  it("honors the signal-specific endpoint", () => {
    expect(traceEndpointFromEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.test/intake"
    })).toBe("https://traces.example.test/intake");
  });
});
