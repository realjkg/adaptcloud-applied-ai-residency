# Sample agent architecture

The workflow intentionally separates deterministic decisions from model reasoning.

1. Validate and bound untrusted intake.
2. Calculate token cost from operator-supplied pricing.
3. Evaluate required controls deterministically.
4. Optionally ask Claude for a bounded architecture recommendation.
5. Return control findings, cost, recommendation, and evidence metadata.

Claude never authorizes its own tools, changes pricing, suppresses control findings, or performs an external action. The local deterministic mode makes tests and onboarding possible without an API key.

## Production extensions

A real engagement must add authentication, authorization, per-tenant storage, managed identity, DLP, immutable audit delivery, rate limiting, evaluation persistence, approved model routing, deployment policy, monitoring, recovery objectives, and a customer-approved data-handling design.
