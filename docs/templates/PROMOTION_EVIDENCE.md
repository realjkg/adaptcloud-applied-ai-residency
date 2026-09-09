# Promotion evidence worksheet

## Candidate identity

- Repository and fork:
- Commit SHA:
- Immutable artifact digest:
- Student-owned environment/account identifiers:
- Evidence mode: simulation or observed

## Concept and architecture

- Selected scenario:
- Business outcome and excluded actions:
- Data classification and retention decision:
- Deterministic controls versus Claude reasoning:
- Architecture decision record:
- Threat model:
- Connector threat model (`docs/adr/0002-mcp-connector-threat-model.md`) reviewed by:

## Environment reviews

| Environment | Result | Evidence references | Missing gates | Reviewer decision |
|---|---|---|---|---|
| Development | | | | |
| Sandbox | | | | |
| QA | | | | |
| Staging | | | | |
| Production review | | | | |

## Well-architected evaluation

| Pillar | Design decision | Test or measurement | Remaining risk | Owner |
|---|---|---|---|---|
| Security | | | | |
| Resilience | | | | |
| Reliability | | | | |
| Cost optimization | | | | |
| Sustainability | | | | |
| Operational efficiency | | | | |

## Operations

- SLO and error-budget decision:
- Load-test result:
- Rollback drill and duration:
- Restore drill, RTO and RPO:
- Model and cloud cost estimate:
- Sanitized trace reference:
- MCP connector state per environment (`MCP_CONNECTORS_ENABLED`, allowed hosts, credential mode):
- Connector review decision — remains disabled, or the owner approval and provider role that permit egress:
- Terraform destroy-plan reference:
- Empty-state and residual-inventory references:
- Billing-console cleanup verification:
- Runbook exercise:
- Go/no-go recommendation and rationale:

This worksheet records an engineering review. It is not a production authorization or compliance certification.
