# ADR 0001: Cloud runtime foundation evidence

- Status: proposed
- Owner: _name/team_
- Scenario: _commercial | banking-payments | insurance_
- Target: _AWS ECS Fargate | GCP Cloud Run_
- Date: _YYYY-MM-DD_
- Image digest: _registry/repository@sha256:..._
- Terraform plan run: _URL_

## Decision

State why this runtime and region fit the scenario. Identify the platform team that owns identity, network, gateway, secrets, state, audit, and incident response. Record alternatives and the reason they were rejected.

## Six-pillar evidence

| Pillar | Decision and measurable evidence | Owner | Expiry/review |
|---|---|---|---|
| Security | OIDC trust conditions; private ingress test; least-privilege review; no stored keys; threat model | | |
| Resilience | failure zones; dependency failure test; scenario RTO/RPO; restore-drill timestamp | | |
| Reliability | SLO/error budget; readiness test; trace link; rollback exercise and duration | | |
| Cost optimization | plan estimate; budget/alert; request/token limits; cost per successful review | | |
| Sustainability | utilization; scaling range; region tradeoff; compute/tokens per successful review | | |
| Operational efficiency | plan review; runbook owner; policy/security gates; drift and patch cadence | | |

## Payment-organization review prompts

For banking/payments, additionally document the cardholder-data boundary, PCI scope owner, tokenization boundary, key-management separation, dual-control approval, immutable transaction references, fraud/AML integrations, and fail-closed behavior. This sample must stay outside that boundary and must never move funds.

## Validation record

- `npm run check`:
- `npm test`:
- `npm run eval`:
- `npm run readiness:production-reference`:
- Terraform fmt/validate:
- Local OTLP trace received:
- Cloud plan reviewed by:
- Rollback/recovery exercise:
- Cleanup/cost confirmation:

## Residual risks and promotion decision

List every unimplemented adapter or unproven control. A green plan is not production approval. Record an explicit **stop**, **revise**, or **approve for synthetic sandbox only** decision and the human approver.
