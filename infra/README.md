# AWS and GCP deployment foundations

These Terraform roots are application-team foundations, not account factories. They consume student-owned identity and network prerequisites, deploy the same digest-pinned container, and place an OpenTelemetry collector beside it. GitHub Actions runs unit tests before validating every pull request. A manual run can create an authenticated plan for every environment and can apply or destroy only a student-owned sandbox.

Nothing here calls or requires an Adapt Cloud account, credential, API, project, state backend, registry, identity, telemetry service, or billing account.

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

- GitHub OIDC trust restricted to the student's fork, approved branch, and target GitHub environment;
- a read-only plan identity for each target environment and a separate least-privilege sandbox mutation identity;
- remote encrypted Terraform state with locking, versioning, retention, and break-glass recovery;
- container registry, image signing/provenance policy, and approved collector digest;
- private networking, DNS, authenticating/rate-limiting gateway, and egress controls;
- managed secret, immutable audit, budget, SLO, paging, and security monitoring destinations.

The AWS root additionally takes at least two private subnets and a service security group. The GCP root takes a project, runtime service account, and one private invoker member. The roots do not create stored access keys or put secrets in state.

Readiness evidence is never invented. Restore, carbon/region, and (on GCP) external automatic-rollback flags default to `false`. A staging service may run for the lab, but a production-configured application fails closed until the responsible owner records the proof and deliberately changes those inputs.

## Engineer sequence

1. Run `npm ci`, `npm run check`, and `npm run test:unit`; do not build an environment unless they pass.
2. Build, scan, sign, and push the application image to the student's registry; copy its `repository@sha256:digest` reference.
3. Copy the relevant `terraform.tfvars.example` to an ignored local `.tfvars` file and replace placeholders with student-owned sandbox resources.
4. Run `terraform init`, `terraform fmt -check`, `terraform validate`, and `terraform plan`. Read every create/change/destroy line.
5. On GitHub, configure the target environment variables listed below and manually run **Infrastructure foundations** with operation `plan`. Download the seven-day text plan and attach it to the change record.
6. For `sandbox` only, review estimated cost and teardown, then run `apply` with confirmation `APPLY MY SANDBOX`.
7. Prove identity, private ingress, `/health/ready`, telemetry arrival, failure rollback, and budget alarms. Record the evidence in `docs/adr/0001-cloud-foundation-decision.md`.
8. Run `destroy` with confirmation `DESTROY MY SANDBOX`. The workflow must prove the Terraform state is empty, query the exact authenticated AWS account or GCP project for remaining repository-labeled sandbox resources, and retain the reports. Verify the billing console separately. QA, staging, and production remain plan-only and require a separate promotion system.

## GitHub environment variables

Create repository environments named `sandbox`, `qa`, `staging`, and `production`, with required reviewers and no stored cloud credentials. Identifiers below are GitHub environment variables; authentication is exchanged through OIDC.

| AWS | GCP |
|---|---|
| `AWS_TERRAFORM_PLAN_ROLE_ARN` | `GCP_WORKLOAD_IDENTITY_PROVIDER` |
| `AWS_TERRAFORM_SANDBOX_ROLE_ARN` | `GCP_TERRAFORM_PLAN_SERVICE_ACCOUNT` |
| `AWS_ACCOUNT_ID` | `GCP_TERRAFORM_SANDBOX_SERVICE_ACCOUNT` |
| `AWS_REGION` | `GCP_PROJECT_ID` |
| `AWS_TF_STATE_BUCKET` | `GCP_TF_STATE_BUCKET` |
| `AWS_TF_STATE_KEY` | `GCP_TF_STATE_PREFIX` |
| `AWS_PRIVATE_SUBNET_IDS_JSON` | `GCP_REGION` |
| `AWS_SERVICE_SECURITY_GROUP_IDS_JSON` | `GCP_RUNTIME_SERVICE_ACCOUNT` |
| `AWS_OTEL_COLLECTOR_IMAGE` | `GCP_INVOKER_MEMBER` |
| `APPLICATION_NAME` | `GCP_OTEL_COLLECTOR_IMAGE` |
| — | `GCP_OTEL_CONFIG_SECRET` |
| — | `APPLICATION_NAME` |

The workflow input supplies the application digest. `AWS_ACCOUNT_ID` and `GCP_PROJECT_ID` are exact non-secret scope checks; `APPLICATION_NAME` must match Terraform's `name` value. The approved collector digest stays in the target's reviewed variable file or environment variable set; it is never silently selected by CI. GCP also needs an existing collector-config secret, populated from `observability/otel-collector.gcp.yaml`, and a runtime service account with narrowly scoped Trace Agent, Monitoring Metric Writer, and Logs Writer permissions. The sandbox mutation identity also needs read-only residual-discovery permission: AWS `tag:GetResources`, or GCP `cloudasset.assets.searchAllResources`. AWS otherwise grants only the task telemetry calls shown in the plan.

## Cleanup hierarchy

1. **Normal:** run a reviewed Terraform destroy plan through the workflow.
2. **Proof:** require an empty Terraform state and empty repository-tagged or labeled sandbox inventory.
3. **Billing check:** inspect the cloud billing console and budget alert after deletion; inventory APIs are not billing systems.
4. **Dedicated-scope emergency:** only when the entire AWS account or GCP project was created solely for this disposable lab, the student may use the provider's account/project cleanup procedure after independently verifying the numeric account ID or project ID.

The repository does not execute `aws-nuke`. That tool is designed to remove all resources in an account and warns that filters do not make it appropriate for an account whose resources cannot be lost. If an instructor permits it for a dedicated disposable AWS account, the student must review its dry run, use an account blocklist, verify the account alias and ID out of band, and invoke the destructive mode manually—not from repository CI. For a dedicated disposable GCP project, project shutdown is the comparable emergency boundary; follow Google Cloud's delete-and-restore procedure and understand that some resources may become unrecoverable before the general recovery window ends.

The residual report is deliberately scoped and read-only. AWS Resource Groups Tagging does not return untagged resources, and Cloud Asset Inventory covers supported resource types. A zero result therefore supplements Terraform state and the billing console; it does not independently prove that the whole account is empty.

## Stop conditions

Do not proceed when a plan includes public ingress, wildcard administration, static cloud credentials, mutable image tags, secrets, or an unexpected replacement/destruction. Stop cleanup when the authenticated account/project differs from the expected scope, state is missing, inventory access fails, or a residual resource remains. Never run account-wide cleanup in a shared, employer, production, or otherwise valuable account. Staging and production must also stop on a single failure zone. Do not use real payment, account, claim, or customer data in this residency.
