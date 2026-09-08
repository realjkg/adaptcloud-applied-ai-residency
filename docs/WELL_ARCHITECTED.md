# Well-architected production promotion

This repository uses one immutable application artifact from development through production. Promotion changes configuration and managed platform dependencies, not application behavior. The reference profile is a deployable contract for a cloud adapter; it is not evidence that any specific environment is compliant or production-authorized.

## Promotion path

```mermaid
flowchart LR
    A["Local deterministic mode"] --> B["Pull-request gates"]
    B --> C["Immutable container"]
    C --> D["Staging with managed services"]
    D --> E["Canary plus SLO gates"]
    E --> F["Production or auto-rollback"]
```

The service reads the same environment contract everywhere. `src/platform/runtime.ts` validates bounds and refuses to start in `production` when required controls are absent. `config/production-reference.env` contains only non-secret reference settings. Credentials must be injected at runtime from a managed secret store or workload identity.

## Six-pillar control map

| Pillar | Development default | Production enforcement | Evidence |
|---|---|---|---|
| Security | No auth, local environment, synthetic data | Trusted gateway, managed secrets, immutable audit sink, private service ingress, least-privilege workload identity | readiness findings, access-policy review, audit delivery test |
| Resilience | One local process and deterministic fallback | Two or more replicas across zones, bounded retries and timeouts, restore drill, dependency circuit breaking at the platform edge | failure-injection result, restore timestamp, recovery evidence |
| Reliability | Console events and health route | Separate live/ready checks, OTLP export, SLO alerts, canary or rolling release, automatic rollback | dashboard link, alert test, deployment record |
| Cost optimization | Token estimate with model disabled by default | Explicit model budget, request and output caps, rate limit, per-scenario cost attribution, budget alerts | cost evaluation, budget configuration, monthly variance |
| Sustainability | Small deterministic process | Demand-based autoscaling, efficient model routing, bounded outputs, region choice balancing carbon, latency, and residency | utilization trend, region decision record, tokens per successful outcome |
| Operational efficiency | Local scripts | Infrastructure as code, immutable image, policy gates, automated smoke/evaluation checks, runbooks, ownership and rollback | CI run, image digest, change record, runbook exercise |

## Service-level overlays

These values are safe starting assumptions for exercises, not customer commitments. A real engagement replaces them through an architecture decision record and load/recovery evidence.

| Scenario | Availability target | RTO / RPO starting point | Failure posture | Cost unit | Retention posture |
|---|---:|---|---|---|---|
| Commercial operations | 99.5% | 4 hours / 24 hours | Queue drafts; never schedule or purchase automatically | cost per reviewed opportunity | Short-lived operational evidence; customer-approved schedule |
| Banking and payments | 99.9% | 30 minutes / 5 minutes | Fail closed; preserve immutable event references; never move funds | cost per reconciled exception | Governed record schedule; no PAN, CVV, or account data |
| Insurance claims | 99.5% | 4 hours / 1 hour | Preserve provenance and missing evidence; human adjudication only | cost per reviewed intake | Policy- and jurisdiction-approved schedule; narratives excluded from logs |

## Platform adapter contract

A production cloud adapter must provide:

1. private ingress behind an authenticating, rate-limiting gateway that sets `x-authenticated-subject`;
2. managed workload identity and secret injection—never secrets in images, source, browser code, or Terraform state;
3. multi-zone orchestration, demand-based autoscaling, disruption budgets, and graceful termination;
4. encrypted tenant-scoped storage plus lifecycle, backup, restore, and deletion controls approved for the scenario;
5. OTLP metrics/traces and immutable metadata-only audit delivery with SLO and budget alerts;
6. egress allow-listing for approved model endpoints, with timeouts, retries, circuit breaking, and a deterministic fallback;
7. an image-digest deployment with canary or rolling health gates and automatic rollback; and
8. reviewed infrastructure as code with policy-as-code, dependency scanning, SBOM/provenance, and drift detection.

Do not expose the service directly when `AUTH_MODE=gateway`: the identity header is trustworthy only when a private network boundary strips external copies and sets it after authentication.

## Commands and promotion gate

```bash
npm ci
npm run check
npm test
npm run eval
npm run readiness:production-reference
npm run build
npm audit --omit=dev
docker build -t adaptcloud-applied-ai-residency:local .
```

The concrete AWS/GCP application adapters are in `infra/`. Their GitHub workflow may mutate only a student-owned sandbox after tests and explicit confirmation. Staging and production are intentionally plan-only: their mutation belongs to a separate organization-controlled system with environment approval, remote state, policy-as-code, and segregation of duties. `docs/adr/0001-cloud-foundation-decision.md` is the evidence record for either target.

For an actual target environment, run `npm run readiness` with its non-secret deployment variables before rollout. Production startup repeats the check and fails closed if any blocker remains. A green reference profile proves only that the configuration contract is internally consistent; owner review, threat modeling, load tests, recovery tests, data governance, and customer acceptance are still required.

## Minimum operational metrics

- request count, duration, rejection, timeout, and error rate by scenario;
- model requests, fallbacks, tokens, estimated cost, and budget utilization;
- deterministic finding counts and human-approval outcomes;
- queue age or concurrency saturation without logging request bodies;
- readiness, replica, deployment, rollback, and restore status; and
- energy proxy metrics such as tokens and compute time per successful reviewed outcome.

Page on user-impacting SLO burn, authentication failure spikes, audit-delivery failure, capacity exhaustion, and budget guard breach. Ticket trends that do not require immediate human action.
