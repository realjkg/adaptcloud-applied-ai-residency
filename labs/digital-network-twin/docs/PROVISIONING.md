# Guarded provisioning

The control surface for provisioning and deprovisioning the twin, tested against a simulated lab tenant. Live adapters for Cloudflare DNS records and four F5 object kinds also exist, **written without access to a real tenant and never run against one**. They are off by default, sit behind the same gate, and are recorded in `docs/adr/0001-live-provisioning-authorization.md`. Nothing in this repository has been applied to a real network.

## Flow

```
render (health-gated) -> plan (dry run) -> human approval -> apply -> verify each write -> destroy
```

1. `prepare` builds the change set from the config, and only if every stage is healthy.
2. `plan` reads current state, writes nothing, and returns a SHA-256 digest of the exact change set.
3. A person writes an approval bound to one action, one tenant, and that digest.
4. `apply` re-checks everything, reads all current state, and only then writes. It reads back each write and compares it with intent.
5. `destroy` removes only objects this twin owns, in reverse order.

## What the gate refuses

Order of checks, first refusal wins. Every reason has a test, and the suite fails if a new reason is added without one.

| Check | Reasons |
|---|---|
| Layer and kill switch | `layer_disabled`, `kill_switch_engaged` |
| Target | `environment_not_lab`, `tenant_not_allowlisted`, `wildcard_not_permitted`, `vendor_not_allowlisted` |
| Transport and size | `transport_unavailable`, `too_many_operations`, `destroy_not_enabled` |
| Live mode | `live_not_authorized`, `host_not_allowlisted`, `object_unsupported` |
| Config and plan | `config_unhealthy`, `dry_run_required` |
| Approval | `approval_required`, `approval_invalid`, `approval_not_yet_valid`, `approval_expired`, `approval_scope_mismatch`, `approval_digest_mismatch` |
| Current state | `conflict_unmanaged`, `drift_detected` |
| Runtime | `operation_failed`, `verification_failed`, `in_use` |

The only environment the layer will act on is `lab`. Anything else, including `production`, `staging`, and a differently cased `Lab`, is refused by construction, not by configuration.

## Approvals

```json
{
  "ref": "TICKET-1234",
  "approver": "a.person",
  "action": "apply",
  "tenantId": "lab-tenant-001",
  "digest": "<digest printed by plan>",
  "approvedAt": "2026-11-19T12:00:00Z"
}
```

An approval covers one action on one tenant for one change set. It must carry a timezone offset, must not be from the future, and expires after 24 hours. Changing a single attribute changes the digest and voids the approval. `approval-template` prints one that is invalid until a person fills in the approver and the time.

The engine checks the binding. It does not authenticate the approver, so a deployment that matters needs signed approvals from an identity system.

## Why create and delete are not symmetric, and what is modeled

| Difference | How the engine handles it |
|---|---|
| A same-named object exists that this twin does not own | Refuses before any write. Never adopts it, never deletes it. |
| An owned object was changed by someone else | Refuses as drift. Review before applying. |
| Delete while another object still refers to it | Refused as `in_use`. Destroy halts. |
| A write fails part-way | Rolls back only what that run created, in reverse order, and reports anything it could not remove. |
| A write is accepted but stored differently | The read-back mismatch halts the run and rolls back. |
| Running apply or destroy twice | Apply reports unchanged. Destroy reports not found and succeeds. |
| Audit and results | Record vendor, object, name, and outcome. Never attribute values. |

`npm run roundtrip` applies and destroys the whole twin against a simulated tenant that already holds objects the twin does not own. The result must show the tenant unchanged and the unmanaged objects intact.

**Not modeled:** Palo Alto candidate versus running configuration and commit, F5 HA configuration sync, DNS and resolver caching after a record is removed, certificate revocation, license activation and deactivation, API rate limits, and vendor-side partial application. Each of these makes real deprovisioning harder than the simulator suggests.

## Threat model

| Threat | Control |
|---|---|
| Acting on the wrong tenant or on production | Environment must be `lab`, the tenant must be on an exact allowlist, no wildcards |
| Applying something other than what was reviewed | Digest of the change set, bound to the approval |
| Replaying an old approval | 24-hour window, action and tenant scope |
| Deleting what the twin does not own | Ownership check on every delete, conflict refusal before every apply |
| Runaway change | Operation cap, kill switch, stage order, halt on first failure |
| Secrets in the change set or the audit trail | Only `secret-store://` references, a health check that rejects secret-like fields, attribute values never logged |
| Generating infrastructure from a bad model | The change set is built only from a config that passes every health check |
| Config text trying to steer the engine | Config is data. It is validated, never executed, and never reaches a command line |

## Live adapters

| Vendor | Implemented | Refused as unsupported, and why |
|---|---|---|
| Cloudflare | DNS records | Zone settings cannot be owned or restored. The managed ruleset replaces a zone's whole rule entry point. |
| F5 BIG-IP | HTTP monitor, pool, pool member, virtual server | Certificates and client SSL profiles need a file upload and a TLS option design. The virtual server only references an existing profile. |
| Palo Alto Networks | none | Rules need service objects the change set does not define, zones cannot carry an ownership mark, and commit is left to a person. |
| Cisco Meraki | none | VPN peers and L3 firewall rules are replaced as whole lists, so one write can remove entries the twin does not own. |

A plan that includes any unsupported object is refused with `object_unsupported` before anything is read, approved, or written, so use `--only` to select exactly the supported objects:

```bash
node tools/provision-cli.mjs plan --policy=provision-policy.live.json --tenant=lab-tenant-001 \
  --only=cloudflare/dns-record,f5/monitor,f5/pool,f5/pool-member,f5/virtual-server
```

What every live call goes through:

- **One HTTP client.** HTTPS only, no credentials in the URL, one exact allowlisted host per vendor, loopback and link-local and metadata addresses always refused even if allowlisted, redirects never followed, small JSON responses only, and a timeout. TLS verification is never disabled. Trust an appliance's private CA with `NODE_EXTRA_CA_CERTS`.
- **Credentials from the environment, at call time.** `CLOUDFLARE_API_TOKEN`, `BIGIP_USERNAME`, `BIGIP_PASSWORD`. They are wrapped so they cannot reach a log, a string, or JSON, and an error names the variable but never the value.
- **An ownership mark on every object**, in the DNS record comment or the F5 description. An object without this twin's mark is never deleted, and a same-named object it does not own blocks the run before any write.
- **Names validated before they reach a URL.** Config is untrusted data.
- **No retries of writes.** A failed write halts the run and rolls back what that run created.

Known residue and limits: BIG-IP leaves the node it creates for a pool member, the F5 adapter changes running configuration only, and read-back normalization against real devices is the most likely place to need adjustment. A mismatch fails closed, as `verification_failed`.

`test/fake-vendors.mjs` is an in-memory fake of the behavior these adapters assume. Passing tests against it shows the adapters are consistent with those assumptions. It does not show the real APIs behave that way.

## Before the first live run

All of these are required. Missing any one means the answer is still no.

1. A recorded owner decision, and a threat model reviewed against the table above.
2. A disposable lab tenant for each vendor, isolated from production and from any customer or employer environment.
3. Least-privilege credentials scoped to that tenant, supplied at run time from workload identity or a secret store. Never an environment file, never this repository.
4. The adapter passes `test/transport-contract.mjs` against the lab tenant itself, not only against the fake.
5. A vendor-specific answer for ownership marking. Tags, descriptions, comments, and name prefixes differ by product, and some objects cannot carry one. Without a reliable owner mark, the safe-delete rule cannot be kept.
6. Explicit handling of commit and sync semantics for each vendor, tested in the lab tenant.
7. A teardown tested on that tenant before the first apply, with the round trip showing it unchanged.
8. Signed per-action approvals, alerting on every apply and destroy, and a tested kill switch.
9. A policy file that references `docs/adr/0001-live-provisioning-authorization.md` and sets `acknowledgesUntested` to true. Start from `config/provision-policy.live.example.json`, which ships disabled and unacknowledged.

## Commands

```bash
npm run roundtrip                                              # prove apply then destroy leaves a simulated tenant unchanged

cp config/provision-policy.example.json provision-policy.json   # then set "enabled": true yourself
node tools/provision-cli.mjs plan  --policy=provision-policy.json --tenant=lab-tenant-001
node tools/provision-cli.mjs approval-template apply --tenant=lab-tenant-001   # complete it, then:
node tools/provision-cli.mjs apply --policy=provision-policy.json --tenant=lab-tenant-001 \
  --approval=approval-apply.json --planned-digest=<digest from plan>
node tools/provision-cli.mjs destroy --policy=provision-policy.json --tenant=lab-tenant-001 \
  --approval=approval-destroy.json                              # also needs "allowDestroy": true in the policy
```

State is kept in `.twin-lab-state.json`, a simulated tenant on disk. `TWIN_PROVISION_KILL=1` refuses everything.
