# Browser twin implementation loop

## Scope
Build a same-origin browser UI and Node JSON API for a configuration-only simulator. Reuse existing lab checks and viewer. Fargate is the hosting target, but this loop does not deploy cloud resources. No vendor calls, arbitrary commands, or live infrastructure writes. Read repository instructions before editing.

## Orchestrator loop
1. Inspect the viewer, simulator, and tests. Record the baseline and assign one bounded work item at a time. Publish file ownership and interface expectations before parallel work.
2. Contract agent: draft OpenAPI for catalog, draft, state, plan, deployment, and operation polling under /api/v1/labs/{labId}. Specify ownership checks, stale revision handling, and idempotency.
3. Simulator agent: implement deterministic monitor and SD-WAN scenario fixtures. Return observed state and evidence separately from desired state. No timers, sockets, or network probes are needed for scenario signals.
4. UI agent: implement edit, preview, deploy to simulator, verify, and restore by replanning a known-good revision. Show the selected SD-WAN path and why it changed.
5. Verification agent: run existing lab tests and new contract and browser tests. Report commands, results, and blockers. The orchestrator integrates only reviewed changes. If a gate fails, assign the smallest fix, rerun the gate, and stop after two unsuccessful repair rounds for human review. Do not start cloud deployment or change scope automatically.

## Required scenarios
- Maintenance: change a backend health monitor, preview the predicted unhealthy member, deploy to the simulator, inspect observed pool state, and restore the known-good revision.
- SD-WAN: model two branch uplinks, a preferred path, a backup, and a policy with latency, jitter, and packet-loss thresholds. Use synthetic observations to demonstrate a healthy preferred path, an SLA breach and failover, both paths unhealthy, and recovery with an explicit failback policy. Show the selected path, measured inputs, and decision reason. Treat this as a policy model, not Meraki firmware parity.

## Exit gates
- Two learner identities cannot read or mutate each other's lab, plans, or operations. Do not ship a development identity bypass.
- Draft writes reject stale revisions. Deployments use server-generated plans, recheck freshness at execution, and execute only once on retry. Malformed input is rejected; exercise-authorized unhealthy states remain simulatable.
- Both scenarios run from the browser with no learner terminal. Existing tests remain green. No vendor credentials, cloud provisioning, or live API calls are introduced.
