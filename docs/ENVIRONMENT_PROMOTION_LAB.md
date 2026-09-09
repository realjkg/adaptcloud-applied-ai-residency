# Environment promotion lab

This lab teaches how one candidate moves from a concept to a production review. It evaluates configuration and evidence; it never deploys or authorizes an environment. Use synthetic data and student-owned accounts only.

## Learning contract

Build once and retain the same immutable artifact identity through every stage. A later environment may strengthen configuration or managed dependencies, but it must not rebuild application code. Promotion is cumulative: a missing earlier gate blocks every later review.

| Stage | Student activity | Required evidence | Promotion question |
|---|---|---|---|
| Development | Map the scenario, implement deterministic controls, run unit tests and model evaluations | requirements, tests, evals, six-scenario matrix | Does the application meet its bounded contract? |
| Sandbox | Exercise the container, Terraform provider mocks, local OTLP path, connector state and cleanup path | artifact identity, container acceptance, connector review, plans, trace, destroy plan and cleanup proof | Can the candidate run and be removed safely in an isolated account? |
| QA | Test API contracts, malformed input, prompt injection, provider failure and supply-chain risk | contract, negative, adversarial and scan results | Does it fail closed without leaking or bypassing controls? |
| Staging | Evaluate production-shaped scale, SLOs, recovery, rollback, cost and sustainability | load result, drills, SLO, cost and region decisions | Can operators detect, recover and control spend? |
| Production | Review the threat model, runbook and accountable approvals | threat model, exercised runbook, change and owner approvals | Should an organization authorize a controlled rollout? |

## Connector review

The `connector-review` gate is a sandbox gate under the security pillar. Sandbox is the first stage
with a real cloud account, injected platform credentials and network egress, so it is the first
place the MCP connector layer in `src/platform/mcp/` could be switched on against something real;
development runs locally against the stub transport. Because gates are cumulative, placing it at
sandbox also makes it required at QA, staging and production, which is what
`docs/MCP_CONNECTORS.md` asks for when it says a live connector needs evidence before staging.

It is a security gate rather than a cost one. The layer's risk is egress and credential blast
radius: an enabled connector can reach a provider account and, if the host checks are wrong, the
instance metadata service. Spend is a second-order effect and is already covered by
`cost-reviewed`.

Satisfy the gate by recording, for the environment under review, whether the layer is enabled, what
`MCP_ALLOWED_HOSTS` and `MCP_CREDENTIAL_MODE` contain, and who reviewed that state. The reference
profiles all ship with the layer off, so the honest sandbox answer is usually "disabled, verified
from the environment file". Enabling it is an owner decision that requires
`docs/adr/0002-mcp-connector-threat-model.md` and everything its decision section lists, and the
gate then needs observed rather than simulated evidence.

## Run the complete emulator

Start from a clean clone. These commands do not need AWS, GCP or Claude credentials:

```bash
nvm use
npm ci
npm run check
npm run test:unit
npm run eval
npm run lab:simulate
npm run readiness:development-reference
npm run readiness:sandbox-reference
npm run readiness:qa-reference
npm run readiness:staging-reference
npm run readiness:production-reference
npm run promotion:simulate -- --environment=all
```

Then run the Terraform, container and telemetry acceptance commands in `docs/STUDENT_HANDOFF.md`. The GitHub Environment promotion workflow runs the ordered evaluator and retains five JSON review manifests.

## Learn by changing evidence

Copy `examples/promotion-evidence.simulated.json`, change one gate to `false`, and evaluate the affected stage:

```bash
cp examples/promotion-evidence.simulated.json /tmp/promotion-evidence.json
npm run promotion:simulate -- --environment=qa --evidence=/tmp/promotion-evidence.json
```

The command must exit non-zero, list the missing gate under its well-architected pillar, and block QA and every later stage. Try the same experiment with `connector-review`: it is earned one stage earlier, so it blocks sandbox as well. Restore the evidence only after documenting what test or review would satisfy it.

## Scenario application

Repeat the review for commercial, payments and insurance. Keep the platform artifact constant, but replace the scenario overlay:

- commercial: availability, downtime economics and approval before purchasing or scheduling;
- payments: idempotency, reconciliation, immutable event references and fail-closed fund-movement boundaries; and
- insurance: evidence provenance, narrative privacy, missing-document handling and human adjudication.

## Observed evidence

The included evidence file uses `evidenceMode: simulation` and `simulation://` references. It demonstrates the end state but proves no real deployment. To create an observed record, replace each passing gate only after the corresponding CI run, cloud plan, trace, test report, drill or approval exists. Use stable, access-controlled references and never embed credentials, customer data, prompts or authentication headers.

`readyForHumanReview` means the supplied evidence is complete enough for the next review. Sandbox cleanup evidence is cumulative: without a reviewed destroy plan and verified empty state/residual inventory, QA and every later review are blocked. `deploymentAuthorized` is always `false`; this repository cannot approve production. Actual QA, staging or production mutation requires organization-owned roles, remote state, GitHub Environment protection, segregation of duties and explicit authorization outside this emulator.

## Student deliverables

Submit the five manifests plus the worksheet in `docs/templates/PROMOTION_EVIDENCE.md`. Explain one blocked-gate experiment and one scenario-specific tradeoff across security, resilience, reliability, cost optimization, sustainability and operational efficiency.
