# Student-owned cloud workflow

Every student operates from their own fork and cloud account. Adapt Cloud does not provide or broker credentials, projects, accounts, state, registries, secrets, billing, deployment identities, telemetry, or production approval. Removing Adapt Cloud access does not affect a student's fork or deployed sandbox.

## Promotion contract

| Environment | Unit tests | Build and readiness contract | Terraform | Mutation |
|---|---|---|---|---|
| Development | required first | local deterministic artifact | none | local process only |
| Sandbox | required first | same container with sandbox profile | validate, plan, destroy and residual verification | manual apply/destroy allowed |
| QA | required first | same digest with QA profile | validate and plan | disabled in this repository |
| Staging | required first | same digest with staging profile | validate and plan | disabled in this repository |
| Production | required first | same digest with fail-closed production profile | validate and plan | disabled in this repository |

The workflow never accepts access keys or service-account JSON. Each fork owner configures GitHub OIDC federation in their own AWS account or GCP project.

## Fork environments

Create GitHub environments named `sandbox`, `qa`, `staging`, and `production`. Require a reviewer for all four; restrict QA, staging, and production to the default branch. Put only non-secret identifiers in environment variables. Cloud trust must restrict the OIDC subject to the student's exact fork and environment.

Use the variables in `infra/README.md`. Sandbox additionally needs a narrowly scoped mutation identity:

- AWS: `AWS_TERRAFORM_SANDBOX_ROLE_ARN`
- GCP: `GCP_TERRAFORM_SANDBOX_SERVICE_ACCOUNT`

Staging and production use plan identities only. Do not grant their plan identities create, update, or delete permissions.

## Safe sequence

1. Fork the repository and replace owner-specific values described in `docs/FORK_SETUP.md`.
2. Run `nvm use`, `npm ci`, and `npm run test:unit` locally.
3. Push a branch and wait for unit tests, environment contracts, and the immutable container build to pass.
4. Build, scan, sign, and push the container into the student's registry; retain its `repository@sha256:digest` reference.
5. Run **Infrastructure foundations** with operation `plan` for the selected environment.
6. Review the plan, estimated charges, identity, ingress, telemetry, and cleanup path.
7. Configure a budget alert in the student's cloud account. For sandbox only, rerun with operation `apply` and confirmation `APPLY MY SANDBOX`.
8. Capture health and OpenTelemetry evidence using synthetic data.
9. Rerun with operation `destroy` and confirmation `DESTROY MY SANDBOX`; require the empty-state and residual-inventory artifacts, then verify the billing console and budget alert.
10. If cleanup cannot be proven, stop promotion and follow the cleanup hierarchy in `infra/README.md`. Never use account-wide cleanup in a shared or valuable account.
11. Produce QA, staging, and production plans as architecture evidence. Apply them only from a separate organization-controlled promotion system after the required production controls exist.

An instructor may review evidence but never receives or operates a student's credentials. Students must not paste credentials into issues, pull requests, logs, screenshots, chat, or Terraform variables.
