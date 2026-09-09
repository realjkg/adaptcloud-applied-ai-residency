---
name: well-architected-review
description: Review an environment or design against the six well-architected pillars this repository enforces — security, resilience, reliability, cost optimization, sustainability, operational efficiency — using the real readiness policy rather than a generic checklist. Use whenever someone asks whether a configuration or environment is production-ready, what is blocking promotion, why production refuses to start, what a scenario's SLO, RTO, RPO, retention, or region choice should be, or wants a pillar-by-pillar review of a change. Required by CLAUDE.md rule 8 before any scenario change.
---

# Six-pillar readiness review

Production in this repository **fails closed**. `assertProductionReady` in
`src/platform/runtime.ts` stops the process before it accepts traffic when a blocking control
is absent, so readiness is not advisory — it is the startup contract. A review's job is to tell
someone exactly which controls are missing, in which pillar, and what evidence would close each gap.

## Run the review

```bash
node .claude/skills/well-architected-review/scripts/pillar-review.mjs --profile=all
```

This parses each `config/*-reference.env` profile through the real
`runtimeConfigFromEnvironment` and `assessRuntimeReadiness`, then groups findings by pillar. The
policy is never re-implemented here — a review that drifts from the code it reviews is worse
than no review.

- `--profile=production` for one stage
- `--env-file=path/to/deploy.env` for a candidate deployment's non-secret variables
- `--json` to feed a report or an evidence pack

Read the earlier stages as a **promotion backlog**, not as failures. Development is meant to
carry gaps; the useful output is which gaps must close before each next stage.

## What each pillar asks

The control map in `docs/WELL_ARCHITECTED.md` is authoritative; read it for the development
default, production enforcement, and required evidence per pillar. The blocking checks are:

| Pillar | Blocking controls | Findings |
|---|---|---|
| Security | authenticating gateway, managed secrets, immutable audit sink | SEC-001..003 |
| Resilience | two or more replicas across zones, proven restore drill | RES-001..002 |
| Reliability | OTLP export, automatic rollback on failed health or SLO gates | REL-001..002 |
| Cost optimization | explicit monthly budget, bounded rate and output | COST-001..002 |
| Sustainability | demand-based autoscaling (blocker), documented region tradeoff (warning) | SUS-001..002 |
| Operational efficiency | reviewed infrastructure as code, bounded timeouts and retries | OPS-001..002 |

SUS-002 is deliberately a warning rather than a blocker: carbon, latency, and residency genuinely
trade against each other, and the residency wants that decision recorded in an ADR by a human,
not silently satisfied by a flag.

## Reviewing a scenario change

`CLAUDE.md` rule 8 requires every scenario change to state its SLO, recovery, cost, retention,
sustainability, and operational effect. The service-level overlays in `docs/WELL_ARCHITECTED.md`
give the starting assumptions — payments at 99.9% with 30-minute RTO and 5-minute RPO, commercial
and insurance at 99.5% — and they are explicitly *hypotheses*, not customer commitments. Treat
them as testable: a change that makes an overlay unreachable is a finding, and a change that
tightens one owes load or recovery evidence.

Answer these in the change itself, not in review comments:

- **SLO:** which target does this affect, and what is the error budget consequence?
- **Recovery:** does RTO or RPO move, and what drill proves the new value?
- **Cost:** what is the new cost per reviewed outcome, and does the budget still hold? Use the
  `tokenomics-estimate` skill for the number rather than asserting one.
- **Retention:** what data is now held, for how long, under whose approval?
- **Sustainability:** does this change tokens or compute per successful outcome?
- **Operations:** what alert, runbook step, or rollback trigger does this add?

## What a green review does and does not mean

A clean profile proves the configuration contract is internally consistent. It is not compliance,
not a deployment approval, and not evidence that any real environment is configured this way.
Owner review, threat modelling, load and recovery tests, data governance, and customer acceptance
remain outstanding — say so when reporting results, because the gap between "readiness check
passed" and "safe to deploy" is exactly where client trust is lost.

## CCA-F domain

Well-architected operations. Pairs with `promotion-evidence` for stage gating and
`tokenomics-estimate` for the cost pillar's numbers.
