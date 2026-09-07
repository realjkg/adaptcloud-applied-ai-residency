# Codex implementation loop: three distinct Adapt Cloud scenarios

Use this block as one contiguous Codex assignment.

```text
Repository: adaptcloud-applied-ai-residency
Working branch: feat/three-scenario-agent-workflows

OBJECTIVE

Extend the existing Adapt Cloud Applied AI Engineer Residency from one generic assessment into three production-shaped, demonstrably different agent scenarios:

1. Commercial operations
2. Banking and payments
3. Insurance claims intake

This is an implementation task. Inspect the repository, design the change, implement it, test it, run adversarial evaluations, update the documentation, and produce an evidence-backed completion report. Continue the loop after failures until every required local gate passes or a genuine external blocker remains.

Do not create three cosmetic variants of the same prompt. The scenarios must share safe platform primitives while retaining different domain contracts, invariants, policies, evaluation criteria, and user experiences.

CURRENT FOUNDATION TO PRESERVE

- TypeScript and Node.js.
- Vitest and the existing CI quality workflow.
- Deterministic operation without an Anthropic API key.
- Optional Claude-assisted reasoning with the model and current pricing supplied through environment variables.
- No client-side secrets.
- Untrusted input is data, never instructions.
- Deterministic policy and authorization cannot be overridden by the model.
- Human approval is required before consequential or external action.
- Evidence metadata must not contain prompt bodies or sensitive content.
- Cursor, Claude Code, Lovable, and Replit must follow the same delivery standard.
- Synthetic data only. Do not claim compliance certification or production authorization.

SCENARIO 1 — COMMERCIAL OPERATIONS

Build a Commercial Maintenance Opportunity Agent for an industrial or field-services company.

Inputs:

- asset or site identifier;
- maintenance observations;
- operational urgency;
- downtime estimate;
- labor and material assumptions;
- customer constraints; and
- applicable approval profile.

Outputs:

- normalized problem summary;
- prioritized recommended work;
- assumptions and missing information;
- estimated operational and financial effect;
- token and model cost;
- proposed work-order draft; and
- explicit human-approval status.

Commercial invariants:

- The agent may draft but never submit a work order, contact a vendor, schedule labor, purchase material, or promise savings.
- Financial estimates must remain deterministic, state their assumptions, and distinguish estimates from observed facts.
- Customer text cannot alter tool permissions or system policy.
- Evidence must support the recommendation and identify uncertainty.

Primary skills demonstrated: workflow mapping, API design, TypeScript, AI-assisted operations, cloud deployment, AI Tokenomics, FinOps, observability, and business-value communication.

SCENARIO 2 — BANKING AND PAYMENTS

Build a Payment Exception Investigation Agent for a bank, payment processor, or merchant-payments team.

Inputs:

- synthetic transaction identifier;
- processor and ledger events;
- integer minor-unit amount and currency;
- idempotency key;
- authorization, capture, settlement, reversal, and refund status where applicable;
- synthetic risk signals; and
- operator approval profile.

Outputs:

- chronological event timeline;
- reconciliation result;
- duplicate or idempotency conflict findings;
- missing or contradictory evidence;
- recommended next operational step;
- escalation severity; and
- immutable evidence metadata.

Payments invariants:

- Never accept or store a real PAN, CVV, bank-account number, credential, or customer record.
- Never initiate, capture, settle, refund, reverse, freeze, or otherwise move money.
- Never decide that a person committed fraud or make an autonomous regulatory report.
- Monetary calculations use integer minor units; currency must be explicit.
- Duplicate idempotency keys and ledger imbalance are deterministic blocking findings.
- Model text may explain evidence but cannot change ledger facts, severity, or approval state.
- Describe PCI-DSS, SOC 2, or other mappings as control-readiness mappings only, never certification.

Primary skills demonstrated: payments lifecycle knowledge, event-driven systems, idempotency, reconciliation, immutable auditability, secure API design, least privilege, incident reasoning, and regulated delivery.

SCENARIO 3 — INSURANCE

Build a First Notice of Loss and Claims Evidence Agent for an insurance carrier or claims administrator.

Inputs:

- synthetic policy summary;
- first-notice-of-loss narrative;
- incident date and loss type;
- submitted-document manifest with stable source identifiers;
- claimant-provided facts;
- missing-information indicators; and
- adjuster approval profile.

Outputs:

- structured claim-intake summary;
- evidence map citing source identifiers;
- missing-document and contradiction findings;
- recommended routing or specialist review;
- questions for the adjuster or claimant;
- uncertainty statement; and
- explicit human-adjudication status.

Insurance invariants:

- Never determine coverage, liability, fault, eligibility, claim value, denial, cancellation, premium, or payment.
- Never infer protected or sensitive characteristics that were not explicitly and legitimately supplied.
- Every material factual statement must map to an input source identifier or be labeled as an inference.
- Missing evidence must remain missing; the model may not fill gaps.
- Adverse or consequential recommendations require human adjuster review.
- Logs must exclude claim narratives and sensitive personal data.

Primary skills demonstrated: document and evidence reasoning, RAG/provenance concepts, privacy, uncertainty, human review, fairness-aware design, structured extraction, and regulated workflow communication.

REQUIRED ARCHITECTURE

1. Introduce a discriminated `scenario` contract rather than optional fields spread through one generic interface.
2. Preserve a small shared kernel for validation, Claude access, model-cost calculation, evidence-envelope creation, logging policy, and human-approval state.
3. Implement each scenario in its own module with its own input schema, deterministic policy engine, output contract, fixtures, tests, and evaluations.
4. Use a versioned response envelope containing at least:
   - `schemaVersion`;
   - `scenario`;
   - `mode`;
   - `decision` or `status`;
   - `findings`;
   - `cost`;
   - `evidence`; and
   - `humanApprovalRequired`.
5. Add versioned routes:
   - `POST /api/v1/scenarios/commercial/assess`
   - `POST /api/v1/scenarios/payments/assess`
   - `POST /api/v1/scenarios/insurance/assess`
6. Add a CLI that selects the scenario explicitly. It must reject a fixture supplied to the wrong scenario.
7. Keep tests and evaluations network-free. Claude failure, timeout, malformed output, or missing configuration must produce a safe deterministic result.
8. Do not add a database, authentication provider, provider-specific deployment, or write-capable external connector merely to make the sample look more complete. Keep the cloud-neutral runtime and container deployable; document managed dependencies behind the platform adapter until a provider is explicitly selected.

WELL-ARCHITECTED PRODUCTION PATH

Build once and promote the same immutable, non-root container through development, staging, and production. Environment differences must be configuration and managed-service bindings, not scenario forks. Do not invent a cloud provider: preserve a cloud-neutral platform adapter contract until the owner selects AWS, Azure, or GCP, then implement exactly one reviewed infrastructure-as-code adapter.

The shared platform must enforce:

- Security: authenticated private ingress, least privilege, managed identity/secrets, tenant boundaries, egress allow-listing, data minimization, immutable metadata-only audit, dependency scanning, and no secret or narrative logging.
- Resilience: multi-zone replicas, graceful termination, bounded timeouts/retries with jitter, load shedding, provider-failure fallback, restore drills, and no retry storms.
- Reliability: separate live/ready checks, request correlation, OTLP telemetry, scenario SLOs and error budgets, canary or rolling health gates, and automatic rollback.
- Cost optimization: per-scenario token/cost attribution, request/output caps, explicit monthly budgets, anomaly alerts, caching only where data policy permits, and deterministic routing before model inference.
- Sustainability: right-sized and demand-based autoscaling, efficient model selection, bounded output, tokens/compute per successful outcome, and a documented region decision balancing carbon, latency, availability, and residency.
- Operational efficiency: reviewed infrastructure and policy as code, immutable image digests, automated tests/evals/security/readiness gates, runbooks, ownership, drift detection, SBOM/provenance, and repeatable rollback.

Use `src/platform/runtime.ts`, `config/production-reference.env`, and `docs/WELL_ARCHITECTED.md` as the minimum cross-scenario contract. Production must fail closed when a blocking readiness control is absent. A passing reference-profile check is not production authorization.

Before implementing a scenario, record its provisional availability target, RTO, RPO, peak/concurrency assumption, data-retention/deletion rule, monthly model budget, degradation behavior, operational owner, and rollback trigger. Treat these as testable hypotheses until customer and owner approval.

TOOL-SPECIFIC ONBOARDING

Claude / Claude Code:

- Update `CLAUDE.md` with the three scenario boundaries and required verification loop.
- Require plan, affected controls, implementation, tests, evaluations, residual risk, and rollback evidence.

Cursor:

- Update `.cursor/rules/adapt-cloud.mdc` so Agent mode cannot merge the domain policies into generic prompt text or weaken deterministic controls.
- Keep one issue and one bounded branch per resident assignment.

Lovable:

- Add three separate UI briefs under `docs/lovable/`.
- Each UI calls only its matching versioned endpoint.
- No API or model key may appear in browser code.
- Payments must display reconciliation and blocking invariants.
- Insurance must display source provenance and human-adjudication status.
- Commercial must display assumptions and approval state beside financial estimates.
- Do not fabricate a working Lovable integration if no connected Lovable project is available; provide precise UI briefs and API contracts instead.

Replit:

- Preserve `.replit` and document scenario commands.
- Configuration secrets remain in Replit Secrets.
- The sample must boot without an Anthropic key in deterministic mode.

IMPLEMENTATION LOOP

Phase 1 — Inspect and baseline

- Read `README.md`, `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, the current source, tests, evaluations, package scripts, and CI workflow.
- Run the existing build, typecheck, tests, and evaluation suite before editing.
- Record the starting commit, current gate results, and any existing failure. Do not attribute inherited failures to this change.

Phase 2 — Model the domains

- Write a short ADR describing the shared kernel and why the three policy engines remain separate.
- Define the scenario contracts and trust boundaries before implementing model prompts or UI briefs.
- Identify deterministic invariants, model-permitted reasoning, prohibited actions, human approvals, evidence requirements, and failure behavior for every scenario.

Phase 3 — Implement the shared kernel

- Add the versioned envelope, explicit scenario dispatch, common cost calculation, bounded Claude adapter, safe fallback, and metadata-only evidence logging.
- Keep model names and prices out of source code.
- Reject unsupported scenarios, oversized inputs, malformed numbers, unknown data classifications, and ambiguous currency values.
- Preserve request correlation, metadata-only telemetry, capacity shedding, graceful termination, bounded model retries/timeouts, budget findings, and fail-closed production readiness.

Phase 4 — Implement each scenario separately

- Implement commercial, then payments, then insurance.
- After each scenario, run its focused tests and evaluations before moving to the next one.
- Do not copy a prompt and rename nouns. Each policy module must enforce its domain invariants deterministically.

Phase 5 — Onboard the development environments

- Update Claude and Cursor repository instructions.
- Add the three Lovable UI briefs and Replit commands.
- Add resident assignments that can be completed with Cursor, Claude Code, Lovable, or Replit while retaining human review.

Phase 6 — Prove behavior

Create at least four evaluation cases per scenario:

1. valid bounded case;
2. missing-control or prohibited-action case;
3. contradictory or malformed evidence case; and
4. prompt-injection or policy-override attempt.

Also prove:

- a fixture cannot be routed to the wrong scenario;
- model unavailability does not bypass controls;
- a model recommendation cannot downgrade a deterministic critical finding;
- sensitive narratives and payment data do not appear in logs or evidence metadata;
- payments catch ledger imbalance and duplicate idempotency keys;
- insurance preserves source provenance and missing evidence;
- commercial estimates expose assumptions and cannot trigger an external action; and
- every prohibited action has a negative test that would fail if its guard were removed or reversed.

Also prove the production path:

- development remains deterministic and credential-free;
- unsafe production configuration refuses to start;
- the production reference profile has no readiness blockers;
- provider timeout, throttling, and 5xx responses fall back safely within the retry budget;
- capacity limits shed load without accepting additional work;
- liveness does not depend on external providers and readiness reflects deployment policy;
- shutdown drains bounded in-flight work;
- model budget breaches are deterministic findings;
- logs contain request metadata but no bodies, prompts, transaction details, or claim narratives; and
- each scenario has an SLO/error-budget test plan, restore exercise, load assumption, and rollback trigger.

Phase 7 — Documentation and resident experience

- Update the README with commands and sample output for all three scenarios.
- Add scenario architecture, data-flow, threat-model, evaluation, and rollback documentation.
- Extend the client-readiness rubric so a resident must pass one scenario deeply and explain the risk differences across all three.
- Add a GitHub issue template for bounded resident assignments.
- Do not use real customer, payment, policy, claim, identity, medical, or government data anywhere in the repository.
- Update the six-pillar map and scenario service-level overlays whenever behavior or operating assumptions change.
- Add a runbook covering provider degradation, capacity exhaustion, audit-delivery failure, budget breach, rollback, and restore.

Phase 8 — Release gates

Run from a clean installation:

- `npm ci`
- `npm run check`
- `npm test`
- `npm run eval`
- `npm run readiness`
- `npm run readiness:production-reference`
- `npm run build`
- `docker build -t adaptcloud-applied-ai-residency:test .`
- one deterministic CLI execution for each scenario
- one API smoke test for each scenario
- `npm audit --omit=dev`
- `git diff --check`

Inspect the final diff for secrets, real personal data, copied credentials, accidental prompt logging, hard-coded model pricing, unbounded external actions, compliance claims, and unrelated changes.

If a gate fails, diagnose the root cause, make the smallest safe correction, and restart the relevant proof phase. Do not weaken a policy, delete an evaluation, loosen a type, skip a gate, or replace a real check with a mock simply to obtain green output.

COMPLETION STANDARD

Declare `READY FOR OWNER REVIEW` only when:

- all three scenarios run independently;
- their contracts and invariants are demonstrably different;
- every local gate passes;
- deterministic mode works without credentials;
- Claude-assisted mode remains subordinate to deterministic policy;
- documentation and tool onboarding are complete;
- the immutable container and production reference profile pass their gates;
- every scenario has explicit SLO, recovery, retention, cost, sustainability, and operational ownership assumptions;
- the final evidence identifies the exact tested commit; and
- no critical or high-severity unresolved issue remains.

Otherwise declare `HOLD — NOT READY FOR OWNER` and provide:

- the exact blocker;
- affected scenario and control;
- evidence already completed;
- the smallest next action; and
- whether owner input or external access is genuinely required.

FINAL REPORT

Return:

1. status: READY or HOLD;
2. scenario-by-scenario behavior delivered;
3. shared components versus deliberately separate components;
4. security, governance, and cost controls;
5. commands and exact gate results;
6. files and documentation added or changed;
7. residual risks and production exclusions;
8. branch and tested commit SHA; and
9. the recommended first resident assignment.
```
