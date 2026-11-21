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
| Learner entry with no live path | `server/learner-deployed.mjs` (local persona test entry: `server/learner.mjs`) | Simulator only |
| HTTP API and browser panels | `server/app.mjs`, `viewer/operate.js` | n/a |

## Roles

| Role | May |
|---|---|
| viewer | read snapshots, changes, and the results of guided-journey jobs |
| operator | also collect now, request changes, execute an approved change, start guided-journey jobs |
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
| Cloudflare edge | Add one WAF custom, redirect, or cache rule to a disposable zone. Structured conditions only; single-rule add and delete never rewrite other rules; zone name and account verified before staging; a synthetic traffic preview in the plan. See `docs/EDGE_CONFIG.md` |
| Meraki SD-WAN | Simulator only. A live target that lists it is refused at load |

Simulator mode covers every vendor and object, including SD-WAN. Live Palo Alto and Meraki need `targets` in settings (disposable lab targets with exact hosts and a credential variable name) and a `policy.liveAuthorization` that references ADR 0002.

## Target resolution

Two server-side registries: synthetic targets (`server/simulator-targets.mjs`, reserved fixtures) and live targets (deployment settings). The browser supplies an alias; the server supplies the mode, the vendor scope, and the capabilities. Scopes are structured: Palo Alto `managementHost`, `deviceGroup`, `firewallSerial`, `vsys`; Meraki `organizationId`, `networkId`, `applianceSerial`.

- **Binding.** A plan stores a fingerprint of the alias, mode, vendor, capability, and resolved scope. At execution the alias is re-resolved before any vendor client exists, and a different fingerprint marks the plan stale. Repointing an alias, or replaying an Austin approval against Plano, cannot execute. The fingerprint also feeds the plan digest.
- **Access.** A deny-by-default policy is checked at plan time, for the approver, and again at execution. Learner labs have members and aliases; live targets list exact principals per alias. A principal outside a lab cannot list, approve, execute, or roll back its operations, and an alias they cannot use answers exactly like one that does not exist.
- **Live inventory checks.** A live registry refuses fixture aliases, fixture scopes, fixture Meraki networks, and placeholder (`.example`) hosts, and every live target must be a disposable lab target with a serial or organization, and an access list. Panorama device groups are refused: this is standalone-firewall scope.
- **Device verification.** Before staging, and again at execution, the adapter checks the device against inventory: Palo Alto reads the firewall serial; Meraki checks the network belongs to the organization and contains the appliance serial. A mismatch refuses the operation.
- **Commit journal.** For Palo Alto, `server/commit-journal.mjs` makes the commit intent durable before the commit is sent, and the job id durable as soon as it is received. Each record is bound to the target fingerprint and plan digest and can be written only once, so a retry or restart cannot submit a second commit. If an intent exists but the commit was not completed, the operation is uncertain. `POST /api/operations/:id/reconcile` (the "Check commit status" button) settles it read-only from the journal: no intent means nothing was submitted; an intent without a job id needs a person; a known job id is looked up once and the running configuration is read back. Reconcile re-checks the target and access like execution does.
  - **If the job id cannot be saved.** The commit was accepted but nothing durable says so. The operation stops as `uncertain` with reason `commit_job_not_recorded`, the job id is shown in the result and audit log so a person can check the firewall, and polling and completion are not reported. A retry returns the existing operation, and reconcile answers "intent without job id: needs a person". Nothing is sent to the firewall again.
  - **No intent is not a clean candidate.** "No commit was submitted" means the journaled path never reached the commit. The candidate edit happens earlier, so an operation that stopped there may still have a staged change. The result carries `candidateMayExist`, reconcile answers `candidate_edit_may_be_staged`, and the page says to inspect or clear the candidate on the firewall.
- Live SD-WAN is never implied by a firewall capability: a live target that lists it is refused at load.

## Guided journey (jobs started from the browser)

`server/tasks.mjs` holds a fixed list of named jobs: the build order, the topology drawing, the plan check, building the twin in order, the stage health checks, a rehearsal on a simulated tenant, the demo runbook check, the return-to-office what-if, the as-built claim, a preview of the change set, and the draw.io export. The browser starts one with `POST /api/tasks/{job}/run`.

- The request carries a job name and, for the stage health check only, one stage from a closed list. Anything else is refused with 422. There is no command, path, or configuration in a request.
- Jobs run inside the server by calling the same functions the command-line scripts call. There is no shell, no child process, no file written to the repository, and no network call.
- Running needs `task:run` (operator, admin). Reading the list and the results needs `task:read` (everyone signed in). A refused run is audited as a denial; every run is audited with the job, the outcome, and the person.
- Results are returned as plain blocks (checks, tables, files, text), and the page draws them as text only. The history is kept in memory for each lab, newest 50, and one job cannot run twice at once in a lab.
- A job result has `ok` (the job ran and its checks held) and an optional `attention` note (the job ran and found something for a person, for example an unmet requirement). The page shows the second as "Needs review".
- A job that could reach a real vendor does not belong in this list. Applying a change, writing Terraform, capturing a snapshot, and the journal volume check are not in it.

Details for testers are in `docs/MANUAL_UI_GUIDE.md`, Journey 3.

## Maintenance scenario

A learner-facing exercise with deterministic server-side fixtures: change a health monitor, preview the predicted effect, deploy to the simulator, and restore a known-good revision. See `docs/MAINTENANCE_SCENARIO.md`.

## Learner isolation

The deployed learner service is `server/learner-deployed.mjs`. It is not the local test entry.

- **Sign-in.** OpenID Connect and enrollment are required. After sign-in the server resolves the lab from enrollment (`settings.labs[lab].members`). An identity in no lab, or in more than one, gets no session. The lab is stored in the server-side session. No request field can set it. The deployed app runs in `learner` mode, where the persona route does not exist. Startup fails, with no listener, unless the settings carry an https origin, OIDC, group-to-role mapping, enrolled labs, and a data directory, and carry no personas or client secret (the learner OIDC client is a public PKCE client). Persona sign-in lives only in `server/learner.mjs` (`npm run control:learner:local`), which nothing deployed imports; `test/learner-isolation.test.mjs` checks the import graph.
- **Every lab-scoped record carries its lab and is checked on every path.** Config changes and operations: list, detail, approve, execute, rollback, reconcile. A record from another lab answers exactly like an unknown id (same status, same body) and triggers no vendor call. Snapshots: the store is scoped, so listing and retrieval both name a scope; a content hash proves integrity, not permission, and identical bytes saved by two labs have two index rows. Schedules, audit events, and the simulated tenant are per lab. A lab administrator sees only events by people enrolled in the same lab and cannot flip the deployment-wide kill switch.
- **Legacy records.** A snapshot with no scope appears in no view. `store.unscoped()` lists them and `store.assignScope(digest, lab)` is the trusted migration step; it is not reachable from the API.
- **No server-side export exists.** The SVG, PNG, draw.io, and JSON captures are built in the browser from snapshots that caller could already load.
- **CI.** `.github/workflows/learner-isolation.yml` runs the lab tests with `CI=true` and `TWIN_REQUIRE_BROWSER=1`, so a missing Playwright fails the run. This workflow has not been run on GitHub.

Example deployed settings (no secrets):

```json
{
  "origin": "https://learn.example.org",
  "dataDir": "/data",
  "oidc": { "issuer": "https://idp.example.org", "authorizationEndpoint": "https://idp.example.org/authorize", "tokenEndpoint": "https://idp.example.org/token", "jwksUri": "https://idp.example.org/keys", "clientId": "learner-app", "groupsClaim": "groups" },
  "groupRoles": { "learners": "operator", "reviewers": "approver", "lab-admins": "admin" },
  "labs": { "lab-a": { "members": ["<oidc subject>"], "aliases": ["pan-dfw-edge", "mx-aus-branch"] } }
}
```

## Learner deployments

`server/learner-deployed.mjs` is the entry for learner-facing tasks (for example Fargate). It has no vendor credentials, no live adapter, no collector, and no identity client in its import graph, and nothing it reaches reads the process environment or makes outbound calls; `test/learner-isolation.test.mjs` fails if that changes. Learners still plan, approve, and execute simulated writes, including SD-WAN, through the same workflow. Run it with `--all-interfaces` only behind the platform's network controls, and give the task no credentials and no route to a management network or the live executor. Those deployment controls (task role, security groups, subnets) are outside this repository and are not changed by it.

## Live settings

`node server/main.mjs --live=settings.json` needs: an `https` `origin`, `dataDir`, `baselinePath`, `tenantId`, `oidc`
(issuer, endpoints, `clientId`, optional `clientSecretEnv`, `groupsClaim`), `groupRoles`, a provisioning `policy` with
the recorded authorization and exact host allowlists, and a `collector` with `enabled`, `acknowledgesUntested`, and
per-vendor `hosts` plus identifiers. Vendor credentials come from the environment: `CLOUDFLARE_API_TOKEN`,
`BIGIP_USERNAME`, `BIGIP_PASSWORD`, `PANOS_API_KEY`, `MERAKI_API_KEY`, and the per-target variables named in `targets[].credentialEnv`. Put a TLS-terminating proxy in front; the service
binds to 127.0.0.1. Run it inside the customer's network, not on a public host.

## Live readiness panel

One panel, three separate verdicts. None implies another, and none authorizes a write:

| Verdict | What it shows | Who starts it |
|---|---|---|
| Storage | Two separate test tasks on the same volume: the second recovers the first's job id and still refuses a second intent. Task ids are shown. Counts as verified only for a runner of kind `ecs-efs`; a local run is labeled "Simulated only". Tied to the deployment, so a different deployment makes it stale. | Admin |
| Firewall preflight | Read-only: appliance identity and the read shapes planning uses. It lists what it did not exercise (the commit and job replies). Tied to the target fingerprint, so repointing an alias makes it stale. | Admin |
| Approved round trip | Computed, not started: a verified create and a freshly planned, separately approved destroy of it, through the normal request, approval, and execution flow. It stops counting if the alias is repointed. | Nobody: it reflects what happened |

The panel cannot provision storage, edit a target, approve, execute, or retry. Storage, targets, and network rules stay in deployment configuration and Terraform. An uncertain commit shows "Manual review required" with any job id captured in the audit record, and the only action is the read-only "Check commit status".

**Not built:** the runner that starts two Fargate test tasks on one EFS access point (it needs AWS access; the panel says "No storage check runner is configured" until one is supplied in the same `run()` contract), and a panel for CI results.

## Verifying the journal volume

The journal's guarantees (a record written once, durable before use) depend on the volume. Before an approved appliance round trip, prove the volume on the real deployment:

1. Mount the chosen persistent volume at the journal path (a Fargate task can use an EFS file system or an EBS volume; use whichever the deployment chose).
2. On the first task: `npm run journal:volume-check -- write --dir=<mount path>`. It exercises hard links, fsync, the write-once refusal, and leaves a marker. It uses the real journal and makes no vendor call.
3. Stop that task and start a replacement mounted on the same volume. Do not just restart a process inside the task.
4. On the replacement: `npm run journal:volume-check -- verify --dir=<mount path>`. It must find the marker, recover the intent and job id, and still refuse a second intent.

This has **not** been run on a real volume. The local tests prove the script's logic on a temporary directory, not that any storage behaves. Passing it proves the volume, not the firewall's response shapes.

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
