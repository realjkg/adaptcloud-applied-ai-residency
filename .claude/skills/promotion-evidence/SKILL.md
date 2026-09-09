---
name: promotion-evidence
description: Evaluate cumulative promotion evidence across development, sandbox, QA, staging, and production, and assemble the evidence pack a change needs — which gates are missing, which pillar each gap belongs to, and what artifact digest ties the stages together. Use whenever someone asks whether a change can be promoted, what is blocking staging or production, what evidence a review needs, how to write an evidence summary or handoff, or is preparing a delivery or client-readiness answer. Required by CLAUDE.md rule 7 for every change.
---

# Promotion evidence and the delivery record

Promotion here is **cumulative and artifact-bound**: one immutable container moves from
development to production, and every later stage still requires every earlier gate. A rebuild
between stages invalidates the evidence that came before it, because the thing reviewed is no
longer the thing being promoted. `src/platform/promotion.ts` holds 24 gates across five stages,
each tagged with the pillar it serves.

## Evaluate the evidence

```bash
node .claude/skills/promotion-evidence/scripts/evaluate-evidence.mjs --environment=all
node .claude/skills/promotion-evidence/scripts/evaluate-evidence.mjs \
  --evidence=path/to/evidence.json --environment=staging
```

Output names each missing gate, the stage where it is earned, and its pillar. A missing QA gate
blocks QA *and* staging *and* production — that is the cumulative rule working, not a bug, and
it is the mechanism that stops a team from outrunning its own testing.

`deploymentAuthorized` is always `false`. Readiness is a review input; authorization is a human
decision made elsewhere, with environment approval, remote state, policy-as-code, and segregation
of duties. Never report a green evaluation as approval to deploy.

## Where gates come from

Each stage's gates map to what that stage is *for* (see `docs/ENVIRONMENT_PROMOTION_LAB.md`):

- **development** — requirements mapped, unit tests, agent evaluations, scenario matrix.
- **sandbox** — immutable artifact, container acceptance, terraform plan, telemetry integration,
  cleanup planned *and* verified. Cleanup is a cost-optimization gate: a lab that leaves
  resources running teaches the wrong habit and bills the student.
- **qa** — contract, negative, and adversarial tests, plus supply-chain scan. QA is failure
  testing; a QA stage that only runs happy paths has not been done.
- **staging** — load test, rollback drill, restore drill, SLO defined, cost reviewed,
  sustainability reviewed. Drills, not documents: a rollback plan nobody executed is a claim.
- **production** — threat model, runbook exercised, change approval, production owner approval.

## Writing the evidence summary

`CLAUDE.md` rule 7 requires files changed, tests, evals, residual risks, and rollback on every
change. Generate the skeleton with the gate runner and fill in the judgement:

```bash
node .claude/skills/residency-gates/scripts/run-gates.mjs --full
```

The two sections nobody can generate for you are the ones that matter most in review:

- **Residual risks.** What remains unproven — failure modes not exercised, assumptions carried,
  controls owed to a real engagement. An empty residual-risk section reads as an unexamined
  change, not a safe one.
- **Rollback.** The revert target, the configuration to restore, and the *signal* that says to
  do it. Reversibility is part of the definition of done, not a contingency.

Record each gate's reference in `docs/templates/PROMOTION_EVIDENCE.md`. A gate marked true with
no reference is an assertion; a gate with a CI run, digest, drill timestamp, or report link is
evidence. Keep `evidenceMode` honest — `simulation` for lab exercises, `observed` only when the
gate genuinely ran against a real environment.

## CCA-F domain

Delivery evidence, promotion gating, and reversibility. Pairs with `well-architected-review`
(which pillar a gap belongs to) and `residency-gates` (running the gates that produce evidence).
