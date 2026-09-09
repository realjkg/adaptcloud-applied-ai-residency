# Claude skills for the residency

These skills turn the repository's operating boundary into procedures Claude can run, rather
than rules it has to remember. Each one wraps a deterministic script that reads the same policy
the service uses — none of them re-implement a control, because a skill that drifts from the
code it describes is worse than no skill.

They are scoped to this repository's principles, which are the architecture baseline
`docs/RESIDENCY.md` and `docs/TOOLS.md` treat as CCA-F preparation. They do not reproduce any
certification blueprint.

| Skill | CCA-F domain | Deterministic backing |
|---|---|---|
| `cca-f-architecture-review` | bounded agency and trust boundaries | `scan-boundaries.mjs` — 9 rules over `SECURITY.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` |
| `well-architected-review` | six-pillar operations | `pillar-review.mjs` — `assessRuntimeReadiness` from `src/platform/runtime.ts` |
| `tokenomics-estimate` | AI Tokenomics and FinOps | `estimate-cost.mjs` — `estimateMonthlyCost` from `src/agent/cost.ts` |
| `promotion-evidence` | delivery evidence and reversibility | `evaluate-evidence.mjs` — the 25-gate matrix in `src/platform/promotion.ts` |
| `scenario-policy` | regulated domain policy | `probe-invariants.mjs` — 14 adversarial probes over `src/labs/simulator.ts` |
| `residency-gates` | definition of done | `run-gates.mjs` — the gates named in `CLAUDE.md` rules 6 and 7 |

## Running them without Claude

Every script is plain Node ESM and runs offline with no API key and no cloud account. They
compile the repository automatically if `dist/` is missing.

```bash
npm run skills:boundaries    # trust-boundary scan
npm run skills:pillars       # six-pillar readiness across every profile
npm run skills:probe         # adversarial scenario invariant probes
npm run skills:evidence      # cumulative promotion gate evaluation
npm run skills:gates         # definition-of-done gates plus evidence summary
npm run skills:cost -- --input-cost=<usd/Mtok> --output-cost=<usd/Mtok>
```

`npm run skills:check` verifies the skill set itself: frontmatter, referenced files, declared
domains, and that every script is present and executable.

## Working on a skill

`tests/skills.test.ts` treats the skill set as part of the delivery surface, so the same
definition of done applies. Three rules keep them trustworthy:

1. **Never re-implement a control.** Import the compiled policy from `dist/`. A second copy of a
   rule becomes a second, wrong answer.
2. **Refuse rather than guess.** `estimate-cost.mjs` exits rather than inventing a model price.
   A confident wrong number is the failure mode these skills exist to prevent.
3. **Say what the check does not prove.** Every script ends by stating its limit. Passing gates
   are not production authorization, and a clean scan is not a safe design.
