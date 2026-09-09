---
name: residency-gates
description: Run this repository's definition-of-done gates — typecheck, tests, agent evaluations, production readiness, and optionally scenario simulations, promotion evidence, and the trust-boundary scan — then emit the evidence summary the change needs. Use before declaring any work complete, opening a pull request, or reporting that a change is done; when someone asks whether the repo is green, what to run before committing, or why a gate is failing; and whenever CLAUDE.md rules 6 and 7 apply, which is every code change.
---

# Running the gates and reporting honestly

`CLAUDE.md` rule 6 names four gates that must pass before work is declared complete, and rule 7
requires an evidence summary. Running them by hand invites a quietly skipped step and a
"should be fine" report, which is the specific failure this skill exists to prevent.

```bash
node .claude/skills/residency-gates/scripts/run-gates.mjs          # the required four
node .claude/skills/residency-gates/scripts/run-gates.mjs --full   # plus scenarios, promotion, boundaries
node .claude/skills/residency-gates/scripts/run-gates.mjs --json   # machine-readable
```

## What each gate proves

| Gate | Command | Proves |
|---|---|---|
| typecheck | `npm run check` | the contract compiles under strict TypeScript |
| unit-tests | `npm test` | positive, negative, and adversarial behaviour holds |
| agent-evaluations | `npm run eval` | the agent meets its evaluation cases offline |
| production-readiness | `npm run readiness:production-reference` | the production contract has no blocking pillar finding |

`--full` adds scenario simulations across both cloud contracts, promotion evidence evaluation,
and the trust-boundary scan. Run the full set whenever a change touches `src/labs/`,
`src/platform/`, `infra/`, or anything a reviewer would want proven beyond the required four.

Everything runs offline. No gate needs an API key or a cloud account — that is a property worth
protecting, because a gate that only passes with credentials stops being run.

## When a gate fails

Fix the cause. Never weaken a gate, relax a bound, skip a test, or narrow an assertion to get
green — `AGENTS.md` states this directly, and it is the one shortcut that destroys the value of
every other gate in the repository.

Read the failure before changing anything. A readiness blocker names its control and pillar; a
scenario simulation failure names the finding that blocked it; the boundary scanner names the
file, line, and the rule it violates. Each is specific enough to act on without guessing.

If a failure reveals that a *control* is wrong rather than the code, say so explicitly and
propose the control change on its own, with the reasoning. Changing a control quietly inside a
feature change is how a boundary erodes.

## Reporting

The script emits the evidence summary skeleton: files changed, gates with timing, residual
risks, rollback. Fill in the last two yourself — they need judgement, and a template cannot
supply it.

Report outcomes faithfully. If a gate failed, say so with the output. If you skipped one, say
which and why. If the work is partially done, say what remains. "Gates pass" is a claim a
reviewer will check, and it is worth exactly as much as its accuracy.

Passing gates mean the change is internally consistent. They are not production authorization
and do not replace owner review, threat modelling, or customer acceptance.

## CCA-F domain

Definition of done and evidence-backed delivery. Produces the raw material for
`promotion-evidence`.
