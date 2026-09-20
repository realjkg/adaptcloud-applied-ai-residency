# CCAR-P study bank

Study-readiness evidence for the Claude Certified Architect – Professional exam, in a format
that appends and compresses instead of being rewritten: line-oriented JSONL, stable ids, and
a shared vocabulary (`d1..d7` domains, `r01..r25` rules) so prose is never duplicated across
records.

| File | Contents |
|---|---|
| `blueprint.json` | Domains, weights, exam format, and the provenance of those numbers |
| `rules.jsonl` | The 25 architect decision rules, each mapped to a domain and a control in this repository |
| `terminology.jsonl` | Terms with domain, definition, the rules they serve, and repository evidence |
| `questions.jsonl` | Practice items with answer, rationale, trap, and rule references |
| `attempts/*.json` | One file per attempt: the option chosen per question id |

## Provenance

The domain weights in `blueprint.json` are transcribed from a third-party reproduction of
Anthropic's Exam Guide v1.0 and are marked `unverified`. Every question and term is original
material derived from public documentation and this repository's own controls — not recalled
exam items. Replace the blueprint table with the official Anthropic Academy candidate guide
before treating any readiness figure as evidence, and set `provenance.status` to `verified`.

## Running it

```
npm run study:readiness          # coverage, attempt scoring, gaps
npm run study:readiness -- --json
node scripts/study-readiness.mjs --attempt=path/to/attempt.json
```

The script validates referential integrity first and exits non-zero on a defect: an unknown
domain, an unknown rule, a duplicate id, an answer that is not one of its options, or weights
that do not sum to 1. A bank that points at something that does not exist cannot support a
readiness claim.

It prints a `digest` over the four bank files. Quote it alongside any readiness figure, the
same way promotion evidence ties every stage to one artifact — a figure from a bank that has
since changed is not evidence of anything.

## Recording an attempt

Write the option you chose per question id. The script grades against the bank, so a score
cannot be self-reported:

```json
{ "id": "2026-09-26-closed-book", "date": "2026-09-26", "mode": "closed-book timed",
  "responses": { "q01": "B", "q02": "A" } }
```

Weighting covers only the domains an attempt actually answered, and the report states what
share of exam weight that was. An unanswered domain reads as missing coverage, never as a
silent zero.

## What the estimated scaled score is not

It is a linear map from weighted accuracy onto the 100–1000 scale, calibrated so 720 falls
where it falls. Anthropic does not publish its scoring model, and this bank is not the exam.
Use the estimate to find weak domains and to decide when to sit the exam; do not report it as
a predicted result.

## Adding official material

Append official items to `questions.jsonl` with `"src":"official"` and terms to
`terminology.jsonl`. Nothing else changes: ids stay stable, existing lines are untouched, and
the digest moves to reflect the new content. Do not paste copyrighted exam items into this
repository — record them by reference and keep the local bank original.
