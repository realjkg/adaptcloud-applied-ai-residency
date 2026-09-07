# AWS and GCP deployment foundations

These Terraform roots are application-team foundations, not account factories. They consume platform-owned identity and network prerequisites, deploy the same digest-pinned container, and place an OpenTelemetry collector beside it. GitHub Actions validates every pull request and can create an authenticated plan on manual request. It has no apply job.

## What is owned here

| Contract | AWS | GCP |
|---|---|---|
| Runtime | ECS Fargate service | Cloud Run v2 service |
| Ingress | Private task ENIs and an existing trusted-gateway security group | Internal/load-balancer ingress and an explicit non-public invoker |
| Identity | Separate ECS execution and workload roles | Existing least-privilege runtime service account |
| Telemetry | ADOT sidecar to X-Ray/CloudWatch-compatible APIs | Google/OpenTelemetry collector sidecar |
| Recovery | ECS deployment circuit-breaker rollback | revision-based rollback is an operator promotion-gate obligation |
| Scaling | desired task floor plus conservative CPU target tracking | min/max instance bounds |

## Platform prerequisites

The platform owner creates these once, outside this application state:

- GitHub OIDC trust restricted to this repository, branch/environment, and the `infrastructure-plan` GitHub environment;
- a read/plan identity that cannot mutate resources;
- remote encrypted Terraform state with locking, versioning, retention, and break-glass recovery;
- container registry, image signing/provenance policy, and approved collector digest;
- private networking, DNS, authenticating/rate-limiting gateway, and egress controls;
- managed secret, immutable audit, budget, SLO, paging, and security monitoring destinations.

The AWS root additionally takes at least two private subnets and a service security group. The GCP root takes a project, runtime service account, and one private invoker member. The roots do not create stored access keys or put secrets in state.

Readiness evidence is never invented. Restore, carbon/region, and (on GCP) external automatic-rollback flags default to `false`. A staging service may run for the lab, but a production-configured application fails closed until the responsible owner records the proof and deliberately changes those inputs.

## Engineer sequence

1. Build, scan, sign, and push the application image; copy its `repository@sha256:digest` reference.
2. Copy the relevant `terraform.tfvars.example` to an ignored local `.tfvars` file and replace placeholders with sandbox resources.
3. Run `terraform init`, `terraform fmt -check`, `terraform validate`, and `terraform plan`. Read every create/change/destroy line.
4. On GitHub, configure environment variables listed below and manually run **Infrastructure foundations**. Download the seven-day text plan and attach the reviewed result to the change record.
5. A human platform owner applies an approved plan from the organization's controlled deployment system. This repository deliberately cannot do so.
6. Prove identity, private ingress, `/health/ready`, telemetry arrival, failure rollback, budget alarms, and cleanup. Record the evidence in `docs/adr/0001-cloud-foundation-decision.md`.

## GitHub environment variables

Use repository environment `infrastructure-plan`, with required reviewers and no secrets.

| AWS | GCP |
|---|---|
| `AWS_TERRAFORM_PLAN_ROLE_ARN` | `GCP_WORKLOAD_IDENTITY_PROVIDER` |
| `AWS_REGION` | `GCP_TERRAFORM_PLAN_SERVICE_ACCOUNT` |
| `AWS_TF_STATE_BUCKET` | `GCP_TF_STATE_BUCKET` |
| `AWS_TF_STATE_KEY` | `GCP_TF_STATE_PREFIX` |
| `AWS_PRIVATE_SUBNET_IDS_JSON` | `GCP_PROJECT_ID` |
| `AWS_SERVICE_SECURITY_GROUP_IDS_JSON` | `GCP_REGION` |
| `AWS_OTEL_COLLECTOR_IMAGE` | `GCP_RUNTIME_SERVICE_ACCOUNT` |
| — | `GCP_INVOKER_MEMBER` |
| — | `GCP_OTEL_COLLECTOR_IMAGE` |
| — | `GCP_OTEL_CONFIG_SECRET` |

The workflow input supplies the application digest. The approved collector digest stays in the target's reviewed variable file or environment variable set; it is never silently selected by CI. GCP also needs an existing collector-config secret, populated from `observability/otel-collector.gcp.yaml`, and a runtime service account with narrowly scoped Trace Agent, Monitoring Metric Writer, and Logs Writer permissions. AWS grants only the task telemetry calls shown in the plan.

## Stop conditions

Do not proceed when a plan includes public ingress, wildcard administration, static cloud credentials, mutable image tags, secrets, a single failure zone, or an unexpected replacement/destruction. Do not use real payment, account, claim, or customer data in this residency.
