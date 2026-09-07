import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export function traceEndpointFromEnvironment(environment: NodeJS.ProcessEnv): string {
  if (environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const baseEndpoint = (environment.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(/\/$/, "");
  return `${baseEndpoint}/v1/traces`;
}

const enabled = process.env.TELEMETRY_EXPORTER === "otlp";

const sdk = enabled
  ? new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "adaptcloud-residency",
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "unknown",
        "deployment.environment.name": process.env.APP_ENV ?? "development"
      }),
      traceExporter: new OTLPTraceExporter({
        url: traceEndpointFromEnvironment(process.env)
      })
    })
  : undefined;

sdk?.start();

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
