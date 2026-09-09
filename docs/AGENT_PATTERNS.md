# Agent architectures available to this repository

What can actually be built here with Claude, what each option costs in complexity, and where this
repository's controls have to sit for each one. Written against the current API surface. Model
identifiers, prices, and beta flags change, so confirm them against Anthropic's documentation
before quoting any of it to a client.

## Contents

- [The tier question comes before the agent question](#the-tier-question-comes-before-the-agent-question)
- [Four ways to build an agent](#four-ways-to-build-an-agent)
- [Where this repository sits today](#where-this-repository-sits-today)
- [Tool types and their scope](#tool-types-and-their-scope)
- [MCP connectors](#mcp-connectors)
- [Model selection and effort](#model-selection-and-effort)
- [What each step would cost this repository](#what-each-step-would-cost-this-repository)

## The tier question comes before the agent question

Most work that gets called an agent is a single call or a workflow. Reaching for an agent when a
workflow would do buys latency, cost, and a much larger failure surface.

| Need | Tier | What to build |
|---|---|---|
| Classification, extraction, summarization, one recommendation | single call | one Messages request |
| Multi-step pipeline where your code decides the order | workflow | Messages plus tool use, orchestrated by you |
| Open-ended task where the model decides the order | agent | one of the four approaches below |

Four checks before choosing the agent tier. If any answer is no, stay one tier down.

- Is the task genuinely hard to specify in advance?
- Does the outcome justify the extra cost and latency?
- Is the model actually good at this task?
- Can an error be caught and reversed — tests, review, rollback?

For this repository, that last check is why the scenarios are read-only. An error in a payment
exception recommendation is caught by the operator who reviews it. An error in an executed
payment is not.

## Four ways to build an agent

Two questions separate them: who supplies the harness (the loop and context management), and who
supplies the deployment.

| Approach | You write | Harness and deployment | Tools | Choose when |
|---|---|---|---|---|
| Manual loop | the `while stop_reason === "tool_use"` loop | you build the harness, you host | only yours | you want to own the whole loop, or you cannot take a beta dependency |
| Tool Runner (`client.beta.messages.toolRunner`) | just the tool functions | SDK supplies the loop, you host | only yours | you want a custom-tool agent without hand-writing the loop |
| Managed Agents | agent config, your tool results | Anthropic supplies both | hosted sandbox with bash, files, code execution, plus Skills, MCP, and yours | you want the loop and a per-session workspace hosted, with persisted versioned configs |
| Claude Agent SDK | a prompt and options | SDK supplies the Claude Code harness, you host | built-in read, write, edit, bash, glob, grep, web, plus MCP and subagents | you want a batteries-included coding or filesystem agent on your own infrastructure |

The Tool Runner and the Claude Agent SDK are different packages that sound alike. The Tool Runner
is part of the regular Anthropic SDK and loops over tools you define. The Claude Agent SDK is
Claude Code as a library, with built-in filesystem and shell tools. Both leave deployment to you.
Only Managed Agents adds hosted deployment.

## Where this repository sits today

`src/agent/claude.ts` runs a **manual loop** over raw HTTP, with four read-only tools from
`src/agent/tools.ts`. It is a workflow with a bounded agentic step, not an open-ended agent, and
that is the correct tier for the job it does.

Three deliberate properties are worth keeping whichever direction this goes.

**No SDK dependency.** The adapter is one `fetch` call. The repository's only runtime dependencies
are OpenTelemetry. Adopting `@anthropic-ai/sdk` would bring the Tool Runner, streaming, typed
errors, and compaction, and would remove hand-written loop code. It also adds a dependency to the
SBOM and the supply-chain scan. That is a real trade, not an obvious win, and it belongs in an ADR.

**No hardcoded model.** `ANTHROPIC_MODEL` is operator-supplied and there is no default. A sample
that pins a model teaches students to pin a model, and the pinned one is wrong within a year.

**Deterministic first.** Policy runs before inference and inference cannot change a finding, a
severity, or an approval. Every agent approach below has to preserve that, and each one makes it
harder as autonomy increases.

## Tool types and their scope

| Type | Runs on | Scope here | Status |
|---|---|---|---|
| Custom tools | your infrastructure | the four read-only tools in `src/agent/tools.ts` | in place |
| MCP connector tools | a remote MCP server | cloud provider read operations, see below | framework in `src/platform/mcp/`, transport stubbed |
| Web search, web fetch | Anthropic | not appropriate — this repo is default-deny egress and synthetic-data-only | not planned |
| Code execution | Anthropic | would let a model run code against intake data | not planned |
| Computer use | either | far outside a read-only assessment agent | not planned |
| Memory | your storage | would create a retention obligation with no data-governance answer yet | needs an ADR first |

The pattern that matters for anything added later: a tool is untrusted at both ends. Its input is
model-generated and must be validated. Its result is external data and must never be read as an
instruction or allowed to change a policy outcome.

## MCP connectors

MCP lets the model call tools hosted by a remote server, including servers the cloud providers
publish. This is the highest-leverage extension available to this repository and the one with the
sharpest edges.

**The API needs both halves.** Declaring `mcp_servers` alone is a validation error. A request needs
`mcp_servers: [{ type: "url", url, name }]` and a matching
`tools: [{ type: "mcp_toolset", mcp_server_name: <same name> }]`, under the MCP client beta flag.
Confirm the current flag before implementing; beta identifiers change.

**What this repository built.** `src/platform/mcp/` holds the connector contract, a pure policy
engine, a credential resolver interface, a registry, and a stub transport. Every call is refused
unless configuration explicitly allows the connector, the operation, and the endpoint host.
Consequential operations need an approval reference and an opt-in by exact name. There is no live
HTTP transport: adding one is a separate change needing owner approval, a threat model, and tests.

**Why the stub is the honest stopping point.** `CLAUDE.md` rule 3 forbids reaching external systems
without approval and tests. A framework with a stub transport lets the policy be exhaustively
tested offline and lets a student see the whole control surface, without the repository quietly
gaining the ability to call a cloud account.

**Secure flow when a live transport is added.** In order:

1. Short-lived credentials only. Workload identity or an OIDC exchange resolved per call. Never a
   long-lived key in config, environment, image, or Terraform state.
2. Least privilege at the provider. The role backing the connector should be read-only in IAM, not
   read-only by convention in this code. Two independent controls, because one will eventually fail.
3. Egress allowlist. Explicit https hosts. Refuse private, loopback, link-local, and metadata
   addresses. Server-side request forgery to the instance metadata endpoint is the standard way a
   connector becomes a credential leak.
4. Operation allowlist by exact name, with no wildcard that can grant a mutation.
5. Human approval for anything consequential, carried as an approval reference the policy checks.
6. Bounded timeout, bounded retries, no retry on a non-idempotent operation, bounded result size.
7. Results are untrusted data. They inform the recommendation and never change a finding.
8. Metadata-only audit of every call and every refusal, with no credential and no result body.

**Reasonable first operations.** Read a deployment or service status, read a cost or budget figure,
read a metric or log summary. Each maps onto evidence the six-pillar map already asks for, so the
connector earns its risk instead of existing to look complete.

## Model selection and effort

Reference figures at the time of writing, per million tokens. Rates and availability change;
confirm before quoting.

| Model | Identifier | Input | Output | Fits |
|---|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | $5 | $25 | architecture reasoning, adversarial review, the recommendation step here |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 | $10 | high-volume scenario assessment where judgement is bounded |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 | classification, extraction, sub-agent workers |

Two levers matter more than the model choice in most workloads.

**Effort.** `output_config.effort` runs from `low` to `max` and controls thinking depth and token
spend within one model. Lower effort on a current model often beats high effort on an older one.
Coding and long-horizon agentic work repay higher effort; classification and high-volume routes
usually do not.

**Deterministic routing.** The cheapest token is the one never sent. This repository answers with
no model call at all by default, which is the largest cost control it has, and it is architectural
rather than a setting.

Run `npm run skills:cost` with the operator's approved rates before putting any figure in front of
a client. Do not quote a rate from memory.

## What each step would cost this repository

| Step | Gains | Costs | Gate |
|---|---|---|---|
| Keep the manual loop | no new dependency, full control | hand-written loop, no streaming | none, this is today |
| Adopt the SDK Tool Runner | less loop code, hooks for approval gates, streaming, typed errors | one runtime dependency in the SBOM and supply-chain scan | ADR |
| Live MCP transport | real cloud evidence in an assessment | outbound egress, credential custody, a new threat model | owner approval, threat model, tests |
| Managed Agents | hosted loop and per-session workspace, scheduled runs | Anthropic-hosted execution, a much larger control surface than a read-only assessor needs | not recommended at this scope |
| Claude Agent SDK | filesystem and shell agent | write-capable tools by default, directly against rule 3 | not appropriate here |

The order matters. Each row assumes the deterministic boundary in `docs/ARCHITECTURE.md` still
holds afterwards, and each one makes holding it slightly harder. Reviewing that boundary is what
`.claude/skills/cca-f-architecture-review` is for.
