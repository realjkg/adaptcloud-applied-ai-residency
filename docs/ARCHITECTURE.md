# Sample agent architecture

The workflow intentionally separates deterministic decisions from model reasoning.

1. Validate and bound untrusted intake.
2. Calculate token cost from operator-supplied pricing.
3. Evaluate required controls deterministically.
4. Optionally ask Claude for a bounded architecture recommendation.
5. Return control findings, cost, recommendation, and evidence metadata.

Claude never authorizes its own tools, changes pricing, suppresses control findings, or performs an external action. The local deterministic mode makes tests and onboarding possible without an API key.

## Runtime boundary

The HTTP layer adds generated request identifiers, metadata-only completion events, bounded request bodies, concurrency shedding, graceful termination, and separate liveness/readiness endpoints. Model calls have bounded timeout, retry, and output settings and return to deterministic mode on provider failure. A configured monthly budget becomes a deterministic finding rather than a model judgment.

Production configuration is parsed once at startup. Unsafe production settings stop the process before it accepts traffic. An authenticating gateway must be the only production ingress; the application does not treat customer-supplied identity headers as trustworthy on a public network.

## Production extensions

A real engagement must implement the cloud adapter in `docs/WELL_ARCHITECTED.md`, including authorization, per-tenant storage, managed identity, DLP, immutable audit delivery, gateway rate limiting, evaluation persistence, approved model routing, deployment policy, monitoring, recovery objectives, and a customer-approved data-handling design.
