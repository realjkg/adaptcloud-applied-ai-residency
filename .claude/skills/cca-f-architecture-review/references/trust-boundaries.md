# Trust boundary map

Each boundary lists what crosses it, the code that enforces it, the scanner rule that catches
a regression, and the failure mode you are protecting against. Use it when reviewing a change,
writing a threat model, or answering "where does Claude's authority stop?".

## Contents

- [1. Intake boundary](#1-intake-boundary)
- [2. Decision boundary](#2-decision-boundary)
- [3. Model boundary](#3-model-boundary)
- [4. Action boundary](#4-action-boundary)
- [5. Evidence boundary](#5-evidence-boundary)
- [Runtime and platform boundaries](#runtime-and-platform-boundaries)
- [Reviewing a new capability](#reviewing-a-new-capability)

## 1. Intake boundary

**Crosses:** client intake, maintenance observations, payment events, claim narratives, documents.

**Enforced by:** `src/agent/validate.ts` (type, length, enum, and numeric bounds before anything
else runs) and per-scenario validation in `src/labs/simulator.ts` (integer minor units, safe
integers, source identifiers).

**Scanner rule:** `INP-B1` — intake interpolated into a system prompt.

**Failure mode:** intake text read as instruction. `src/agent/claude.ts` states in its system
prompt that intake is untrusted data, but that instruction is a mitigation, not the control.
The control is that nothing the model returns can change a policy outcome — see boundary 2.
Prompt injection is expected, not exceptional: the scenario probes in the `scenario-policy`
skill assert that instructions embedded in observations and narratives change nothing.

## 2. Decision boundary

**Crosses:** the outcome itself — findings, severity, cost, approval state, readiness.

**Enforced by:** `src/agent/governance.ts` (AC-001..AC-005), `src/agent/cost.ts` (operator
pricing only), `src/platform/runtime.ts` (`assessRuntimeReadiness`, `assertProductionReady`),
`src/platform/promotion.ts` (gate matrix), and the scenario policies in `src/labs/simulator.ts`.

**Scanner rules:** `AGY-B1` (model output assigned to severity, approval, or authorization),
`COST-B1` (hardcoded pricing).

**Failure mode:** a plausible model answer suppressing a finding or raising a budget. Note how
`src/agent/workflow.ts` orders this: cost, findings, and the budget breach are computed first;
the model call happens after; the recommendation text can be replaced but the findings cannot.
Budget breach becomes `COST-001`, a deterministic finding — not a model judgement.

## 3. Model boundary

**Crosses:** the network call to the model provider.

**Enforced by:** `src/agent/claude.ts` as the single adapter — the only reader of
`ANTHROPIC_API_KEY`, with `runtime.requestTimeoutMs`, `modelMaxAttempts`, and
`modelMaxOutputTokens` bounding time, retries, and output. Every failure path returns
`undefined`, which puts the workflow back on the deterministic result.

**Scanner rules:** `SEC-B1` (credential in browser code), `SEC-B2` (credential read elsewhere),
`NET-B1` (egress outside the adapter).

**Failure mode:** retry storms, unbounded spend, a provider outage becoming an availability
incident, or a second code path acquiring model access without review. Degradation must cost
capability, never a control: absent configuration yields `mode: "deterministic"`, which is why
tests and onboarding need no key at all.

## 4. Action boundary

**Crosses:** anything that changes the world — submitting a work order, moving funds,
determining coverage, deploying infrastructure.

**Enforced by:** `humanApprovalRequired: true` on every lab result, the prohibited-action list
in `commercialPolicy`, the `fundsMoved`/`fraudDecisionMade` and
`coverageDetermined`/`liabilityDetermined`/`paymentAuthorized` domain assertions, and
`deploymentAuthorized: false` in `src/platform/promotion.ts`. The infrastructure workflow may
mutate only a student-owned sandbox; QA, staging, and production are plan-only.

**Scanner rule:** `AGY-B2` — approval waived or deployment self-authorized.

**Failure mode:** an agent that recommends becoming an agent that acts, one convenience at a
time. `CLAUDE.md` rule 3 makes the crossing explicit: no write-capable tool without human
approval and tests.

## 5. Evidence boundary

**Crosses:** what gets written down.

**Enforced by:** `promptLogged: false` and `sensitiveContentLogged: false` in the evidence
envelopes, metadata-only completion events in `src/server.ts`, and the OTLP integration test
asserting that intake text never reaches an exported span.

**Scanner rules:** `EVD-B1` (envelope declares content was logged), `SEC-B3` (log statement
emits intake, narrative, or prompt fields).

**Failure mode:** an audit trail that is itself a data breach. Evidence must be sufficient to
reconstruct a decision and insufficient to reconstruct the customer's content.

## Runtime and platform boundaries

`docs/WELL_ARCHITECTED.md` holds the platform adapter contract; two boundaries there are easy
to get wrong:

- **Ingress.** `AUTH_MODE=gateway` is trustworthy only behind private ingress that strips
  external copies of `x-authenticated-subject` and sets it after authentication. Exposing the
  service directly with gateway mode configured converts a header into an authentication bypass.
- **Egress.** Approved model endpoints only, with timeouts, retries, circuit breaking, and the
  deterministic fallback. Default-deny is the posture; each allowed destination is a decision.

## Reviewing a new capability

Work through this before implementation. If any answer is "we would find out in production",
the design is not ready.

1. Which boundary does it cross, and is a crossing genuinely required?
2. What is the smallest read-only version that delivers the value?
3. Which deterministic check authorizes it, and can model output influence that check?
4. What happens on model failure, timeout, malformed output, and hostile input?
5. Who approves, on what evidence, and what does the record show without exposing content?
6. What is the blast radius, the detection signal, and the rollback?
7. Which pillar in `docs/WELL_ARCHITECTED.md` gains a new obligation, and what evidence proves it?
