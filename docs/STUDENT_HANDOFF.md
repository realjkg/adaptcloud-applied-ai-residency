# Student handoff acceptance

This is the clean-room path a student should complete without Adapt Cloud credentials, infrastructure, services, or operator access. Use synthetic data only.

## Before starting

The student needs Linux, macOS, or Windows with WSL2, plus Git, Node 22, npm 10, Docker with Compose, and Terraform 1.10 or later. AWS, GCP, Vercel, and Anthropic accounts are optional until the corresponding live exercise. The student owns every account, credential, state backend, registry, telemetry destination, and charge.

## Credential-free acceptance

From a new fork and clean clone:

```bash
nvm use
npm ci
npm run check
npm run test:unit
npm run eval
npm run lab:simulate
npm run promotion:simulate -- --environment=all
npm run readiness:production-reference
npm run build
terraform -chdir=infra/aws init -backend=false
terraform -chdir=infra/aws test
terraform -chdir=infra/gcp init -backend=false
terraform -chdir=infra/gcp test
docker build -t student-residency:local .
IMAGE_TAG=student-residency:local npm run acceptance:container
npm run acceptance:telemetry
```

Expected result: six scenario/cloud simulations and all five environment reviews pass, both Terraform mock plans pass, the hardened container accepts only the intended requests, graceful shutdown is recorded, and the local collector receives a trace without intake content or authentication headers. Promotion remains an evaluation and never authorizes deployment.

## Optional student-owned services

### Claude

Start with one synthetic scenario. Confirm model name and current input/output pricing before spending tokens:

```bash
ANTHROPIC_API_KEY=... \
ANTHROPIC_MODEL=... \
INPUT_COST_PER_MTOK=... \
OUTPUT_COST_PER_MTOK=... \
npm run lab:simulate:claude -- --scenario=commercial --cloud=aws
```

Never paste the key into source, an issue, a pull request, a screenshot, Terraform, or browser code.

### Cloud sandbox

Follow `docs/STUDENT_BYOC.md`. Plan first. Apply only `sandbox` with `APPLY MY SANDBOX`; collect sanitized health, trace, cost, and rollback evidence; then destroy with `DESTROY MY SANDBOX`. Verify both Terraform state and the billing console. Staging and production remain plan-only.

## Evidence to submit

- fork URL and tested commit SHA;
- clean-room workflow URL;
- six-line lab result with no payloads;
- AWS and GCP mock-plan results;
- SBOM artifact and security-scan result;
- container live/ready, oversized-request, gateway-auth, and shutdown results;
- sanitized trace ID and duration, not the trace payload;
- optional live-Claude model and cost metadata, never its key;
- optional sandbox plan/apply/destroy workflow URLs, empty-state report, residual-inventory report, and billing-console verification; and
- a short ADR describing remaining production gaps.

## Stop conditions

Stop and ask the fork owner when a credential appears in output, a payload appears in telemetry, an image is not digest-pinned, a plan creates public ingress, a non-sandbox mutation is offered, the authenticated cloud scope differs from the expected scope, cleanup cannot be proven, or expected charges are unclear. Never use account-wide cleanup in a shared or valuable cloud account.

## Handoff definition

The repository is ready for guided student use when all three GitHub workflows are green on the same commit and a new fork completes the credential-free acceptance without undocumented values. This does not certify production, PCI DSS, SOC 2, insurance compliance, or customer-data authorization.
