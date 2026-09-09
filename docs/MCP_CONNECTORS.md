# MCP connectors to cloud providers

How a cloud-provider MCP server can be attached to this agent, what the repository enforces before
a call leaves, and what is deliberately not built yet.

## What exists and what does not

`src/platform/mcp/` holds the whole control surface: the connector contract, a pure policy engine,
a credential resolver interface, the single call path, and a deterministic stub transport.

There is **no live HTTP transport**. Every call runs against the stub. That is the honest stopping
point: `CLAUDE.md` rule 3 forbids reaching an external system without explicit approval and tests,
and a framework with a stub lets the policy be exhaustively tested offline while a student sees the
entire control surface, without the repository quietly gaining the ability to call a cloud account.

Adding a live transport is a separate change requiring owner approval, a threat model, and its own
tests. The checklist for that change is at the end of this document.

## The two halves the API needs

An MCP connector on the Messages API needs both a server declaration and a matching toolset entry.
Declaring only `mcp_servers` is rejected as a validation error.

```jsonc
{
  "mcp_servers": [{ "type": "url", "url": "https://…", "name": "aws-readonly" }],
  "tools": [{ "type": "mcp_toolset", "mcp_server_name": "aws-readonly" }]
}
```

This is behind an MCP client beta flag. Confirm the current flag and the availability of MCP on
your chosen platform before implementing; beta identifiers change and availability differs between
the first-party API and the cloud-hosted variants.

## What the policy refuses

`evaluateConnectorCall` is pure and runs before anything else. It returns a specific machine-readable
reason so a refusal can be audited rather than guessed at. The order is: layer switch, environment,
request shape, connector, limits, wildcard, egress, operation, approval.

| Control | Refusals |
|---|---|
| Default deny | `connector_layer_disabled`, `unknown_connector`, `connector_not_enabled` |
| Production gating | `production_requires_managed_secrets`, `production_requires_gateway_auth` |
| Request shape and limits | `request_invalid`, `limits_invalid` |
| No wildcards anywhere | `wildcard_not_permitted` |
| Egress allowlist | `endpoint_url_invalid`, `endpoint_not_https`, `endpoint_userinfo_not_permitted`, `endpoint_host_metadata_service`, `endpoint_host_not_public`, `endpoint_host_not_allowlisted` |
| Operation allowlist | `unknown_operation`, `operation_not_allowlisted` |
| Human approval | `consequential_operation_requires_approval`, `consequential_operation_not_opted_in`, `approval_reference_invalid`, `approval_reference_mismatch`, `approval_reference_expired` |

The call path adds runtime refusals: `call_limit_reached`, `concurrency_limit_reached`,
`credential_unavailable`, `transport_unavailable`, `transport_timeout`, `transport_refused`,
`redirect_not_permitted`, `content_type_not_allowed`, `result_too_large`,
`result_not_serializable`. Thirty-one reasons in total.

Every reason has a test, and the suite fails if a new reason is added without one.

Three decisions inside that list are worth understanding rather than just reading:

**SSRF checks run before the host allowlist.** A metadata or private address is refused even if an
operator explicitly allowlists it. The allowlist can narrow the permitted set, never re-open it.
Server-side request forgery to the instance metadata endpoint is the standard way a connector turns
into a credential leak, so it is not left to operator discipline.

The host is canonicalized before any of those checks: lowercased, IPv6 brackets stripped, and every
trailing root dot removed. That last step is not cosmetic. `metadata.google.internal.` and
`metadata.google.internal` resolve to the same place, but only the second matched a name-based rule
before canonicalization existed, so a dotted spelling walked past the metadata guard, the loopback
rule, and the bare-label rule. Allowlist entries are canonicalized on both sides of the comparison,
so a dotted entry cannot re-open a blocked address either. `npm run connector:simulate` proves the
ordering rather than asserting it: every egress case allowlists the host it expects to be refused.

**An endpoint carrying userinfo is refused.** `https://user:pass@host/` parses to an allowlisted
host but a live client would send those credentials as Basic auth, which is a static secret entering
through configuration — the one path `credentials.ts` exists to prevent.

**An approval is bounded at both ends.** Timestamps must be strict ISO-8601 with an offset, an
approval issued in the future is refused, and the window cannot exceed 24 hours. A zone-less
timestamp was previously read as local time, which could move the window by up to fourteen hours
from what the approver saw.

**A wildcard anywhere invalidates the binding.** Not just a bare `*`: `aws.read_*` is refused too.
A prefix wildcard is how an allowlist silently grows to include an operation nobody reviewed.

**A redirect is not followed by default.** `maxRedirects` defaults to zero. A redirect is how an
allowlisted host hands the call to one that was never reviewed, so following one has to be asked
for explicitly and narrowly, and the cap is two even then.

**An unexpected content type is refused, not parsed.** `allowedContentTypes` defaults to exactly
`application/json`. Wildcards and parameters are rejected in configuration, so `*/*` cannot be
introduced by an operator who wanted to stop a mismatch warning.

**An oversized result is refused, not truncated.** A truncated cost or deployment figure is worse
than an absent one, because it still looks like an answer.

## Consequential operations

An operation that changes something in the provider needs three separate things, and the absence of
any one is a distinct refusal:

1. it appears in `allowedOperations`;
2. it appears in `allowedConsequentialOperations`, by exact name; and
3. the call carries an approval reference bound to that connector and that operation, inside its
   validity window.

The starter descriptors declare a few consequential operations (`aws.set_budget`,
`gcp.deploy_service_revision`, and similar) precisely so policy can classify and refuse them by
name. None of them is in any default allowlist.

## Credentials

No configuration variable carries a credential. `MCP_CREDENTIAL_MODE` selects which resolver the
host injects — `denied`, `workload-identity`, or `oidc-exchange` — and the material itself resolves
at call time from the platform, after policy has already allowed the call.

Secrecy is structural rather than procedural. A resolved credential holds its material in a private
field, and its `toJSON`, `toString`, and Node inspect hook all return `[redacted]`, so a credential
cannot reach a log, an error message, or a result by being passed to something that stringifies it.
A resolver that throws has its rejection value discarded unread, because that value may itself carry
the material.

The default is `denied`. With the layer switched on and no resolver configured, every call is
refused after policy with `credential_unavailable`, which is the correct posture for a repository
that ships with no cloud account.

## Configuration

All off in every shipped reference profile. Enabling an egress path is an owner decision.

| Variable | Meaning |
|---|---|
| `MCP_CONNECTORS_ENABLED` | Master switch, default `false`. Anything but `true` leaves the layer disabled. |
| `MCP_ALLOWED_HOSTS` | Comma-separated egress hostname allowlist. No scheme, no wildcard. Empty means every endpoint is refused. |
| `MCP_AWS_ENABLED`, `MCP_GCP_ENABLED` | Per-connector enable. |
| `MCP_AWS_ENDPOINT_URL`, `MCP_GCP_ENDPOINT_URL` | https URL whose host must also appear in the allowlist. |
| `MCP_AWS_ALLOWED_OPERATIONS`, `MCP_GCP_ALLOWED_OPERATIONS` | Exact operation names. Defaults to the read-only starter set. |
| `MCP_AWS_ALLOWED_CONSEQUENTIAL_OPERATIONS`, `MCP_GCP_ALLOWED_CONSEQUENTIAL_OPERATIONS` | Default empty. An entry still requires a per-call approval reference. |
| `MCP_CALL_TIMEOUT_MS` | 1–30000, default 5000. |
| `MCP_MAX_ATTEMPTS` | 1–3, default 2. Retry applies only to an idempotent read. |
| `MCP_MAX_CALLS_PER_EXCHANGE` | 1–16, default 4. |
| `MCP_MAX_RESULT_BYTES` | 1–262144, default 16384. |
| `MCP_MAX_REDIRECTS` | 0–2, default 0. Zero means do not follow. |
| `MCP_ALLOWED_HOSTS` entries | Canonicalized and shape-checked at parse time. A scheme, port, path, userinfo, wildcard, empty label, or IP literal disables the layer. |
| `MCP_ALLOWED_CONTENT_TYPES` | Up to 8 exact `type/subtype` media types, default `application/json`. No wildcard, no parameters. |
| `MCP_MAX_CONCURRENT_CALLS` | 1–8, default 2. Bounds calls in flight for one exchange. |
| `MCP_CREDENTIAL_MODE` | `denied`, `workload-identity`, or `oidc-exchange`. Default `denied`. Never a credential value. |

A limit outside its bounds disables the entire layer rather than falling back to a default. A
connector that half-reads its configuration is worse than one that is off, because the operator
believes a control is in place.

## Audit

Every call emits exactly one event, on every path: policy refusal, runtime refusal, and success.
A refusal that leaves no trace is indistinguishable from a call that never happened.

The event records connector id, operation, operation class, decision, refusal reason, attempt
count, duration, result byte size, and the approval id when one was presented. It cannot record
anything else, because the event type is closed and scalar-only: there is no field able to hold
the tool input, the result body, an endpoint path or query, a credential, or a credential error.
The shape is the control rather than the discipline of whoever writes the next call site. The
endpoint host is omitted entirely, and connector and operation names are validated before they are
recorded, since on an invalid request they come from the caller rather than from operator config.

A sink failure never changes a call outcome. The call already happened either way, and an
observability fault must not become an authorization result.

## Simulating the connector layer

```bash
npm run connector:simulate
npm run connector:simulate -- --connector=aws-mcp --json
```

The harness drives the whole declared inventory through the real call path against the deterministic
stub: every read-only operation as an allowed call, every consequential operation as a refusal, plus
transport faults, wire faults, egress faults, configuration faults, bounds, production gating,
credential failure, and adversarial bodies carrying instruction-like and credential-like text. Every
case asserts two invariants whatever the outcome: exactly one audit event, and no canary from the
input or the body anywhere in it.

It reports refusal-reason coverage, and that number is the honest measure of a run — a high pass
count over a narrow set of cases proves little. The case list is derived from the exported connector
descriptors, so a new operation is covered without editing the harness.

What it does not establish: anything about TLS, DNS resolution or rebinding, real redirect behaviour,
proxies, request smuggling, or partner outages. Those remain contractual until a transport exists,
and no number of green simulation runs changes that.

## Results are untrusted

Everything an MCP server returns is untrusted input, exactly like client intake. It is wrapped in
`McpUntrustedData` so a reader cannot mistake it for a control value, and unwrapping it is an
acknowledgement that the content is untrusted.

It never becomes an instruction, and it never changes a policy outcome, an approval state, or a
finding severity. The deterministic checks run before the call and are not re-evaluated afterwards.
A connector result can inform a recommendation; it cannot move a finding.

## Starter operations

Read-only, and each maps to evidence the six-pillar map in `docs/WELL_ARCHITECTED.md` already asks
for, so the connector earns its risk instead of existing to look complete.

| Provider | Operations |
|---|---|
| AWS | service deployment status, cost summary, budget status, log summary, metric summary |
| GCP | revision status, billing summary, budget status, log summary, metric summary |

Endpoint hosts are not baked into the descriptors. They come from operator configuration only.

## Before adding a live transport

In order, and none of these is optional:

1. **Owner approval.** The threat model now exists at `docs/adr/0002-mcp-connector-threat-model.md`
   and covers URL parsing and check ordering, redirects, DNS rebinding and time-of-check to
   time-of-use, reserved and metadata address space, proxy and smuggling boundaries, credential
   custody and resolver failure, response handling, and the trust classification of results. It is
   explicit about which controls are implemented and which are contractual until a socket exists.
2. **Least privilege at the provider.** The role backing the connector must be read-only in IAM,
   not read-only by convention in this code. Two independent controls, because one will fail.
3. **Short-lived credentials only.** Workload identity or an OIDC exchange. Never a long-lived key
   in configuration, environment, image, or Terraform state.
4. **Egress allow-listing at the platform**, matching the application allowlist. The application
   check is a second line, not the only one.
5. **Metadata-only audit** of every call and every refusal: connector, operation, decision, reason,
   duration, and approval reference. No credential, no result body.
6. **Tests for the transport itself**, including timeout, refusal, oversized result, and a
   connection to a host that policy would refuse.
7. **The `connector-review` promotion gate**, satisfied with observed rather than simulated
   evidence. It sits at the sandbox stage under the security pillar, because sandbox is the first
   environment with a real cloud account, injected platform credentials, and network egress.
   Gates are cumulative, so it is also required at QA, staging, and production.
