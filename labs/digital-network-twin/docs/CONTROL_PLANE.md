# Control plane

The service behind the browser tool: a collector that reads vendor APIs, single sign-on with roles, snapshot storage
and scheduling, and write controls. Start the simulator with `npm run control` and open the printed address.

```
browser (viewer + operate panel)
   | HTTPS, session cookie, CSRF token
control-plane service  -- sign-in (OIDC) -- roles -- audit log (hash-chained)
   |-- scheduler -> collector (GET only, guarded HTTP) -> snapshot -> store (content-addressed, immutable)
   '-- change workflow -> guarded provisioning gate -> transport (simulator, or live adapters)
```

## Status

All of it is exercised against fakes: a simulated tenant, fake vendor responses, and a local identity provider that
signs tokens with a test key. **None of it has run against a real vendor or identity provider.** Live mode is refused
without the settings below. Palo Alto and Meraki now have live write adapters that follow the per-execution authorization below (`docs/adr/0002-per-execution-authorization.md`).

| Piece | Where | Real systems |
|---|---|---|
| Collector (Cloudflare, F5, Palo Alto, Meraki; GET only) | `tools/collect/` | Untested |
| OpenID Connect sign-in, PKCE, ID-token verification | `server/oidc.mjs` | Untested against a real provider |
| Roles from provider groups; deny by default | `server/roles.mjs` | n/a |
| Sessions: idle and absolute timeout, CSRF | `server/sessions.mjs` | n/a |
| Snapshot store with holds and retention | `server/store.mjs` | Local directory only |
| Scheduler with overlap guard and pause on repeated failure | `server/scheduler.mjs` | n/a |
| Hash-chained audit log | `server/audit.mjs` | n/a |
| Config change workflow (request, approve, execute) | `server/changes.mjs` | Simulator for all four vendors; live for Cloudflare DNS and F5 |
| Target change workflow with per-execution authorization | `server/operations.mjs`, `server/targets.mjs` | Simulator and live |
| Palo Alto and Meraki write adapters | `server/adapters/` | Fakes only |
| Learner entry with no live path | `server/learner.mjs` | Simulator only |
| HTTP API and browser panels | `server/app.mjs`, `viewer/operate.js` | n/a |

## Roles

| Role | May |
|---|---|
| viewer | read snapshots and changes |
| operator | also collect now, request changes, execute an approved change |
| approver | approve or reject a change, read the audit log |
| admin | schedule, hold, kill switch, collect, request, execute, read the audit log |

Roles come from the identity provider's group claim through an exact mapping in settings (`groupRoles`). A person with
no mapped group has no access. Nobody approves a change they requested, including an admin who is also an approver.
Roles are checked on the server for every action. The browser only hides buttons.

## Write controls

Two paths, one rule: enabling an adapter authorizes nothing, and every execution is authorized on its own.

**Config changes (Cloudflare, F5, and the simulator).** A request names controls (an object type at one vendor), an action, and optionally a proposed config. The health gate runs, a dry run reads current state, and the digest and baseline are recorded. A different approver approves that plan before it expires. Execution re-reads state; a changed baseline marks the plan stale. A repeat returns the first result.

**Target changes (Palo Alto, Meraki, SD-WAN).** The operator picks an allowlisted target id and a change type, plus the change's own fields. The server resolves the target, so the browser cannot supply a host, URL, API request, or commit command. Then:

1. The server reads the current configuration and builds a dry-run diff. For Meraki the diff is the whole ordered before and after list and shows that unrelated rules are unchanged. For Palo Alto it shows the candidate edit and the exact commit scope.
2. A different approver approves the plan digest, which covers the target, change type, change, baseline, proposed state, and commit scope. The plan expires after 30 minutes.
3. Immediately before writing, the server re-checks the operator's role, that the target and change type are still allowlisted, the approval, the kill switch, the recorded authorization (live), and drift.
4. The executor writes, reads back, and audits. If the outcome is uncertain, it reads the target first. It retries at most once, only when the target is unchanged, and otherwise stops as uncertain.
5. A rollback is a new request with its own plan and approval. It is refused unless the object or rule is exactly what this system created.

| Target | First live scope and guardrail |
|---|---|
| Palo Alto | Create one address object on a disposable firewall. Candidate edit and commit are separate; the approval shows the partial-commit scope; planning is refused with pending candidate changes; a queued commit job is not success; the running config is read back |
| Meraki | Add one L3 firewall rule on a disposable MX network. The full list is round-tripped or refused; the approver confirms an exclusive change window because the endpoint has no conditional update; the list is read back |
| Meraki SD-WAN | Simulator only. A live target that lists it is refused at load |

Simulator mode covers every vendor and object, including SD-WAN. Live Palo Alto and Meraki need `targets` in settings (disposable lab targets with exact hosts and a credential variable name) and a `policy.liveAuthorization` that references ADR 0002.

## Target resolution

Two server-side registries: synthetic targets (`server/simulator-targets.mjs`, reserved fixtures) and live targets (deployment settings). The browser supplies an alias; the server supplies the mode, the vendor scope, and the capabilities. Scopes are structured: Palo Alto `managementHost`, `deviceGroup`, `firewallSerial`, `vsys`; Meraki `organizationId`, `networkId`, `applianceSerial`.

- **Binding.** A plan stores a fingerprint of the alias, mode, vendor, capability, and resolved scope. At execution the alias is re-resolved before any vendor client exists, and a different fingerprint marks the plan stale. Repointing an alias, or replaying an Austin approval against Plano, cannot execute. The fingerprint also feeds the plan digest.
- **Access.** A deny-by-default policy is checked at plan time, for the approver, and again at execution. Learner labs have members and aliases; live targets list exact principals per alias. A principal outside a lab cannot list, approve, execute, or roll back its operations, and an alias they cannot use answers exactly like one that does not exist.
- **Live inventory checks.** A live registry refuses fixture aliases, fixture scopes, fixture Meraki networks, and placeholder (`.example`) hosts, and every live target must be a disposable lab target with a serial or organization, and an access list. Panorama device groups are refused: this is standalone-firewall scope.
- **Device verification.** Before staging, and again at execution, the adapter checks the device against inventory: Palo Alto reads the firewall serial; Meraki checks the network belongs to the organization and contains the appliance serial. A mismatch refuses the operation.
- **Commit journal.** For Palo Alto, `server/commit-journal.mjs` makes the commit intent durable before the commit is sent, and the job id durable as soon as it is received. Each record is bound to the target fingerprint and plan digest and can be written only once, so a retry or restart cannot submit a second commit. If an intent exists but the commit was not completed, the operation is uncertain. `POST /api/operations/:id/reconcile` (the "Check commit status" button) settles it read-only from the journal: no intent means nothing was submitted; an intent without a job id needs a person; a known job id is looked up once and the running configuration is read back. Reconcile re-checks the target and access like execution does.
- Live SD-WAN is never implied by a firewall capability: a live target that lists it is refused at load.

## Learner deployments

`server/learner.mjs` is the entry for learner-facing tasks (for example Fargate). It has no vendor credentials, no live adapter, no collector, and no identity client in its import graph, and nothing it reaches reads the process environment or makes outbound calls; `test/learner-isolation.test.mjs` fails if that changes. Learners still plan, approve, and execute simulated writes, including SD-WAN, through the same workflow. Run it with `--all-interfaces` only behind the platform's network controls, and give the task no credentials and no route to a management network or the live executor. Those deployment controls (task role, security groups, subnets) are outside this repository and are not changed by it.

## Live settings

`node server/main.mjs --live=settings.json` needs: an `https` `origin`, `dataDir`, `baselinePath`, `tenantId`, `oidc`
(issuer, endpoints, `clientId`, optional `clientSecretEnv`, `groupsClaim`), `groupRoles`, a provisioning `policy` with
the recorded authorization and exact host allowlists, and a `collector` with `enabled`, `acknowledgesUntested`, and
per-vendor `hosts` plus identifiers. Vendor credentials come from the environment: `CLOUDFLARE_API_TOKEN`,
`BIGIP_USERNAME`, `BIGIP_PASSWORD`, `PANOS_API_KEY`, `MERAKI_API_KEY`, and the per-target variables named in `targets[].credentialEnv`. Put a TLS-terminating proxy in front; the service
binds to 127.0.0.1. Run it inside the customer's network, not on a public host.

## Known limits

- The commit journal needs a persistent volume that supports hard links and fsync. Operations whose commit intent was recorded but never confirmed need a person: no automatic resubmission exists.
- Pending config-change requests live in memory and are lost on restart. Target operations are saved to a file, and one found mid-write becomes uncertain. The audit log is durable.
- Sessions are in memory, so one instance only and a restart signs everyone out.
- No sign-in rate limiting, no refresh of provider keys beyond a ten-minute cache, no group-claim paging.
- The Meraki collector needs the regional host in `hosts`; the guarded client does not follow redirects.
- The snapshot store is a local directory. Object storage with write-once retention would implement the same methods.
- Collector response shapes follow `docs/API_NOTES.md` and are unverified against live devices. The F5 collector does
  not read monitors or client SSL profiles, and the Palo Alto collector reads the first member of each list.

- The Palo Alto partial commit request matches the PAN-OS documentation. The job-status, pending-list, and running-config response shapes are unconfirmed on a real device. This is a standalone firewall scope; Panorama device-group scoping and push to managed firewalls are not implemented.
- The Meraki exclusive-window confirmation is a human attestation, not a lock.

Rollback: delete `server/`, `tools/collect/`, `viewer/operate.js`, the two test files, and this file, and restore the
"Change" section of `viewer/index.html`.
