# Cloud foundation lab for engineers and architects

The lab builds experience relevant to enterprise application and platform roles: translate controls into cloud primitives, review change plans, instrument a service, investigate failure, and present evidence. It does not reward merely running a deployment command.

## Local OpenTelemetry exercise

First run the complete credential-free matrix. It executes the commercial, payments, and insurance policy engines against both cloud adapter contracts. The ordinary command disables Claude even if a shell happens to contain a key:

```bash
npm run test:unit
npm run lab:simulate
```

The six application simulations pair with `terraform test` provider mocks in `infra/aws/foundation.tftest.hcl` and `infra/gcp/foundation.tftest.hcl`. Mock plans evaluate the real Terraform configuration without authenticating, creating resources, or estimating actual cloud charges.

Start the collector, then run the application with OTLP export enabled:

```bash
docker compose -f compose.otel.yaml up collector
TELEMETRY_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=adaptcloud-residency-local \
npm run dev
```

Send the synthetic assessment in `examples/client-intake.json`. The collector's debug output should show an HTTP server span with service and deployment attributes. Health traffic is intentionally excluded. The existing metadata-only request event remains in application stdout; neither signal contains prompt or request bodies.

Stop if telemetry includes intake content, credentials, identity tokens, or headers. Capture only a sanitized trace identifier and timing—not the full payload—as portfolio evidence.

## Cloud plan exercise

Choose one cloud first. Configure only a read/plan identity through GitHub OIDC, fill the application-layer inputs in `infra/README.md`, and run the manual plan workflow. Explain the plan in a short design review:

- which controls the application root enforces;
- which controls remain platform prerequisites;
- how the trusted gateway prevents spoofed `x-authenticated-subject` values;
- where logs, metrics, traces, audit evidence, and alerts terminate;
- how a failed revision rolls back without bypassing human approval; and
- how the environment is destroyed or handed back before costs accumulate.

Repeat in the second cloud and compare primitives without changing the application artifact.

## Optional live Claude exercise

The default matrix is deterministic and cannot spend model tokens. To test the real Claude adapter, use a student-owned key and select one scenario and cloud first:

```bash
ANTHROPIC_API_KEY=... \
ANTHROPIC_MODEL=... \
INPUT_COST_PER_MTOK=... \
OUTPUT_COST_PER_MTOK=... \
npm run lab:simulate:claude -- --scenario=commercial --cloud=aws
```

The adapter sends only a synthetic, minimized architecture summary. The insurance narrative, payment events, maintenance observations, credentials, and source identifiers are not included in the model request. Review the configured model and current pricing before running the live option.

## Scenario depth

| Scenario | Required exercise | Architect-level extension |
|---|---|---|
| Commercial | Trace one synthetic assessment and test capacity shedding | Defend a 99.5% SLO and cost-per-reviewed-opportunity dashboard |
| Banking/payments | Demonstrate fail-closed gateway access and immutable references with synthetic data | Draw the PCI boundary, dual control, key ownership, and reconciliation failure path |
| Insurance | Demonstrate provenance/missing-evidence handling and metadata-only telemetry | Defend jurisdictional retention, human adjudication, and model-risk review boundaries |

## Completion rubric

An engineer is competent when they can reproduce the plan, diagnose a failed readiness/telemetry check, and explain rollback and cost. An architect adds an ADR that makes ownership and trust boundaries explicit, quantifies SLO/RTO/RPO/cost assumptions, and identifies what remains unproven. Neither role should claim production or compliance readiness from this lab alone.
