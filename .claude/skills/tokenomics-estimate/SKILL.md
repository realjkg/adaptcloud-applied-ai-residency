---
name: tokenomics-estimate
description: Produce a deterministic, defensible token-cost estimate and unit economics for an intake or scenario — monthly spend, cost per request, cost per reviewed outcome, budget headroom, and volume sensitivity — using operator-supplied pricing only. Use whenever someone asks what an agent workload will cost, whether it fits a budget, how to reduce spend, what cost per outcome is, or is preparing a FinOps or AI Tokenomics answer. Also use before claiming any cost figure to a client, and whenever a change alters token volume, model choice, or output bounds.
---

# AI Tokenomics: estimating spend you can defend

A cost figure given to a client becomes a number they plan against. The discipline this skill
enforces is that every figure traces to operator-supplied pricing and stated assumptions — never
to a rate recalled from memory, which is how confident, wrong quotes get made.

## Run the estimate

```bash
node .claude/skills/tokenomics-estimate/scripts/estimate-cost.mjs \
  --intake=examples/client-intake.json \
  --input-cost=<usd per Mtok in> --output-cost=<usd per Mtok out> \
  --budget=500 --outcome-rate=0.8
```

The script refuses to run without pricing, by design. Published model rates change and vary by
tier and context; the fork owner supplies the approved model and its rates
(`INPUT_COST_PER_MTOK`, `OUTPUT_COST_PER_MTOK` per `.env.example`). If you do not have them, ask
— an invented rate is worse than a missing one because it looks authoritative.

`--outcome-rate` is the fraction of requests that reach a reviewed outcome. Cost per *request*
flatters the system; cost per *reviewed outcome* is the unit the six-pillar map actually names,
and it is the number a client compares against the human cost it replaces.

## Reading the result

- **Monthly spend** comes from `estimateMonthlyCost` in `src/agent/cost.ts` — the same function
  the running service uses, so the estimate and the runtime cannot disagree.
- **Budget breach** is a deterministic finding (`COST-001`), raised in `src/agent/workflow.ts`
  before any model call and again by readiness. It is never a model judgement, and the model
  cannot argue it away.
- **Volume sensitivity** shows 0.5x through 5x, because request volume is the assumption clients
  revise most often and a single point estimate hides the cliff.

State plainly what the estimate excludes: platform, storage, egress, retrieval, human review
time, and evaluation runs. Model tokens are usually not the largest line in a real engagement,
and saying so builds more credibility than a precise-looking total.

## Reducing cost without weakening controls

In rough order of leverage:

1. **Route deterministically first.** The cheapest token is the one never sent. This repository's
   default mode answers with no model call at all; a well-designed scenario reserves inference
   for what genuinely needs judgement.
2. **Bound output.** `MODEL_MAX_OUTPUT_TOKENS` caps the expensive side — output typically costs
   several times input per token.
3. **Right-size the model.** Efficient model selection is a sustainability control in
   `docs/WELL_ARCHITECTED.md`, not only a cost one. Match model to task difficulty.
4. **Trim input.** Retrieve less, summarize upstream, drop fields the decision does not use.
5. **Cache only where data policy permits** — the qualifier is the whole point. Cross-tenant or
   regulated content is not cacheable merely because caching is cheaper.

Rate limits and concurrency caps (`RATE_LIMIT_PER_MINUTE`, `MAX_CONCURRENT_REQUESTS`) bound the
worst case; a budget without a rate limit is a hope, not a control.

Never reduce cost by removing a control. Dropping PII scanning, audit logging, or human approval
saves money by moving risk onto the client — and that trade is theirs to make explicitly, not
yours to make quietly.

## Presenting to a client

Give the estimate, the assumptions, the sensitivity range, and the exclusions together. Label it
an estimate, not a quote. Where an assumption is weak — volume, output length, review rate — say
which one moves the number most, and what evidence would firm it up.

## CCA-F domain

AI Tokenomics and FinOps. Feeds the cost-optimization pillar in `well-architected-review` and the
`cost-reviewed` gate in `promotion-evidence`.
