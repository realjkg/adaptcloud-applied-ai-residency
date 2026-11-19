# 0001: Live provisioning authorization

Status: recorded. A live policy must reference this file by path, and must acknowledge the limits below.

## Decision

The repository owner explicitly authorized adding write-capable code that can create and delete objects on real vendor systems, and waived the requirement in `CLAUDE.md` rule 3 that such code be tested before it is written. The instruction was: "Bypass rule #3, authorized. Write write-capable code for them untested."

The adapters are in `tools/live/`. They cover Cloudflare DNS records and four F5 BIG-IP object kinds (HTTP monitor, pool, pool member, virtual server).

## What this authorizes

- Writing the live adapters, the HTTP client they use, and the policy and engine changes that admit them.
- Running them, by a person with credentials, against a disposable lab tenant that person owns, after the conditions below are met.

## What this does not authorize

- Running anything against production, a customer or employer environment, or any tenant that is not a disposable lab tenant.
- Weakening any control. The default-deny gate, the lab-only environment rule, the exact tenant and host allowlists, the digest-bound approvals, the ownership rule, the read-back verification, and the kill switch all apply to live mode unchanged. A test or a deadline is not a reason to relax one.
- Treating the adapters as verified. They were written without access to a real tenant, credentials, or the vendors' API schemas, and they have been exercised only against an in-memory fake that implements the behavior the author assumed.

## Known limits

- **Unverified API shapes.** Request bodies, paths, and especially the read-back normalization may differ from the real APIs. A mismatch is designed to fail closed: the read-back comparison halts the run and rolls back what that run created. Expect to adjust the adapters on first contact with a real system.
- **Not implemented, refused as unsupported:**
  - Palo Alto Networks: security rules need service objects the change set does not define, zones and address objects cannot carry an ownership mark, and commit is left to a person.
  - Cisco Meraki: VPN peers and L3 firewall rules are replaced as whole lists, so one write can remove entries this twin does not own.
  - Cloudflare settings and rulesets: a setting cannot be owned or restored safely, and the managed ruleset replaces a zone's whole rule entry point.
  - F5 certificates and client SSL profiles: they need a file upload and a TLS option design.
- **Residue.** BIG-IP creates a node automatically when a pool member is added, and it remains after the member is deleted. The adapter leaves it for a person to review.
- **Running configuration only.** The F5 adapter does not save configuration or sync a device group.
- **Approvals bind, they do not authenticate.** The engine checks that an approval matches an action, tenant, and digest. It cannot verify who wrote it.

## Conditions before the first live run

All of these must be true. They restate the checklist in `docs/PROVISIONING.md`.

1. A disposable lab tenant for each vendor in use, isolated from production, with credentials scoped to that tenant and supplied at run time from the environment or a secret store.
2. A policy file that sets `"transport": "live"`, references this file, acknowledges that the adapters are untested, and lists exact hosts for each vendor. The appliance's CA must be trusted through `NODE_EXTRA_CA_CERTS`. TLS verification is never disabled.
3. A `plan` run, read in full, against the lab tenant, and a signed-off approval bound to that exact digest.
4. A first run limited with `--only` to the single lowest-risk object kind, for example a DNS record in a throwaway zone, applied, verified by hand, and destroyed.
5. A person watching the vendor's own audit log during the run.

## Consequences

The unverified code is now in the repository. The controls above are what make that acceptable, and they are covered by tests. The adapter behavior itself is not covered by anything but the fake, and that gap is recorded here so it is not forgotten.
