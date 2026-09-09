# Sample agent architecture

The workflow intentionally separates deterministic decisions from model reasoning.

1. Validate and bound untrusted intake.
2. Calculate token cost from operator-supplied pricing.
3. Evaluate required controls deterministically.
4. Optionally ask Claude for a bounded architecture recommendation, with read-only tools available for deterministic facts.
5. Return control findings, cost, recommendation, and evidence metadata.

Claude never authorizes its own tools, changes pricing, suppresses control findings, or performs an external action. The local deterministic mode makes tests and onboarding possible without an API key.

## Scenario surface

`src/scenarios/` holds the discriminated scenario contract and the versioned response envelope. Each scenario keeps its own request shape, and `parseScenarioRequest` rejects a payload that declares a different scenario than the one requested. Assessing a payments file as a claim would produce a confident answer about the wrong domain, so the mismatch is refused before any field is read.

The envelope carries `schemaVersion`, `scenario`, `cloud`, `mode`, `status`, `humanApprovalRequired`, `findings`, `cost`, `domain`, `recommendation`, and evidence metadata. `POST /api/v1/scenarios/{commercial,payments,insurance}/assess` serves it behind the same authentication, capacity, and body-size boundary as the generic route. A blocked assessment answers 200: it is a completed deterministic refusal, not a request to retry.

The scenario policies live in `src/labs/simulator.ts` and the registry imports them rather than restating them. A second copy of a rule becomes a second, divergent answer.

## Cloud connectors

`src/platform/mcp/` is a default-deny layer for attaching cloud-provider MCP servers. A call is refused unless configuration names the connector, the operation, and an allowlisted public https host; mutations additionally need a per-call human approval reference. Credentials resolve at call time from workload identity or an OIDC exchange and are structurally unable to reach a log or a result. There is no live transport, and adding one needs owner approval, a threat model, and tests. `docs/MCP_CONNECTORS.md` holds the detail.

## Model tools

`src/agent/tools.ts` exposes four read-only tools so the model can cite deterministic facts instead of assuming them: token cost, control findings, runtime readiness, and promotion gates. Each wraps existing code and computes nothing of its own.

The registry is structurally incapable of a write. Tool input is untrusted and validated before use, unknown names are refused as a normal result rather than an exception, refusal reasons never echo the input back, and pricing and runtime configuration come from operator environment rather than from tool arguments, so the model cannot assert a cheaper price or a cleaner posture. Calls are capped per exchange by a caller-held counter, because an unbounded loop is a cost and availability incident. Any failure in the exchange returns nothing and the workflow falls back to the deterministic recommendation.

## Runtime boundary

The HTTP layer adds generated request identifiers, metadata-only completion events, bounded request bodies, concurrency shedding, graceful termination, and separate liveness/readiness endpoints. Model calls have bounded timeout, retry, and output settings and return to deterministic mode on provider failure. A configured monthly budget becomes a deterministic finding rather than a model judgment.

Production configuration is parsed once at startup. Unsafe production settings stop the process before it accepts traffic. An authenticating gateway must be the only production ingress; the application does not treat customer-supplied identity headers as trustworthy on a public network.

## Production extensions

A real engagement must implement the cloud adapter in `docs/WELL_ARCHITECTED.md`, including authorization, per-tenant storage, managed identity, DLP, immutable audit delivery, gateway rate limiting, evaluation persistence, approved model routing, deployment policy, monitoring, recovery objectives, and a customer-approved data-handling design.
