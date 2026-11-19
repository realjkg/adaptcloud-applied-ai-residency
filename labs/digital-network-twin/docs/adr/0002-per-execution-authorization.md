# 0002: Per-execution authorization for live Palo Alto and Meraki writes

Status: recorded. A live control-plane policy must reference this file by path and acknowledge the limits below.

## Decision

The repository owner directed that Palo Alto and Meraki live write adapters be included in the private control plane alongside Cloudflare and F5, with authorization required for each execution rather than granted by enabling an adapter. Learner-facing Fargate tasks keep simulated writes, including SD-WAN changes, and have no vendor write credentials and no route to the live executor.

## What authorizes one live write

1. An operator selects an allowlisted target and a supported change type. The server resolves the target. The browser cannot supply a vendor URL, a raw API request, or a commit command.
2. The server reads current configuration and produces a dry-run diff. A different person approves an expiring plan bound to the exact target, change type, change, baseline, proposed state, and commit scope.
3. Immediately before execution the server re-checks the operator's role, that the target and change type are still allowed, the approval, the kill switch, the recorded authorization, and drift. A changed baseline requires a new plan and approval. A retry returns the existing operation.
4. The executor reads the result back and audits it. If the outcome is uncertain it reads the target before retrying, retries at most once and only when the target is unchanged, and otherwise stops. A rollback is a separate change with its own plan and approval, and it is refused if the object was edited after this system created it.

## Scope

- Palo Alto: create an address object on a disposable firewall or dedicated device group. The candidate edit and the commit are separate steps and the approval shows the commit scope. The commit is a partial commit by the API administrator, a queued job is not success, and the running configuration is read back. Planning is refused if the candidate has pending changes. Delete exists only as a rollback of an object this system created.
- Meraki: add an L3 firewall rule to a disposable MX network. The approver sees the whole ordered before and after list. A list that cannot be round-tripped is refused. Because the endpoint replaces the whole list with no conditional update, the approver must confirm an exclusive change window. Remove exists only as a rollback of a rule this system added.
- Meraki SD-WAN policy changes are a separately allowlisted change type. They are implemented for the simulator only. A live target that lists one is refused when settings load.
- Cloudflare DNS and F5 objects keep their adapters. Their approvals are now bound to the baseline and expire, and execution re-checks drift.

## What this does not authorize

- Running against production, a customer or employer environment, or any target that is not a named disposable lab target. Settings that list such a target are refused.
- Weakening a control. The role checks, separation of duties, digest-bound approvals, ownership marks, read-back verification, kill switch, and audit apply unchanged.
- Treating the adapters as verified. They were written from documentation and are tested only against fakes.

## Known limits

- Palo Alto XML commit, job, pending-change, and running-config calls follow the documentation read and the author's understanding of response shapes. The pending-change listing in particular (`show config list changes`) was not confirmed on a real device. A shape mismatch fails closed, so expect to adjust on first contact.
- A fresh read detects drift before a Meraki write but cannot prevent an out-of-band edit during it. The exclusive-window confirmation is a human attestation, not a technical lock.
- Meraki redirects are not followed. The target host must be the regional host.
- Approvals bind to identities from sign-in. They are as strong as the identity provider's session, not a hardware-backed signature.
- Operations persist to a local file. A restart marks any operation found mid-write as uncertain.

## Conditions before the first live run

1. A named disposable target per vendor, in settings, with credentials scoped to it and supplied from the environment.
2. Settings that set `policy.liveAuthorization` to this file with `acknowledgesUntested: true`.
3. A plan read in full, and an approval from a different person for that exact plan.
