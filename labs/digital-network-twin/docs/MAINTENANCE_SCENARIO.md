# Maintenance scenario: change a health monitor

A learner changes a backend health monitor, previews which pool members the change would take out, deploys it to the simulator, reads the observed pool, and restores a known-good revision. All of it runs in the browser against the learner service, with simulated backends only.

## Three separate parts

| Part | File | Knows about |
|---|---|---|
| Decision rules | `server/scenarios/monitor-model.mjs` | Monitors, answers, pools. Nothing about where an answer came from. |
| Observations | `server/scenarios/maintenance-fixtures.mjs` | A fixed table of how each backend answers each path. Static, frozen data: no clock, randomness, timers, or network. |
| Workflow | `server/scenarios/maintenance.mjs` | Revisions, plans, freshness, once-only deploy, lab isolation. |

The browser supplies a monitor path and an expected response and nothing else. It never supplies observations. The model is covered by its own tests with no fixtures in sight, and a test checks that the model does not import the fixtures.

## The story the fixtures tell

The pool has two members. app-1 runs a new build that serves `/health` and `/healthz`. app-2 runs an old build that serves `/health` only. Changing the monitor to `/healthz` looks harmless; the preview shows app-2 going unhealthy (404) and the pool becoming degraded.

## Rules the workflow enforces

- **Plans are server-generated** from a base revision and a digest of the fixtures, and expire after 30 minutes. Previewing changes nothing.
- **Deploy re-checks freshness.** If the lab has moved to a newer revision, or the fixtures changed after the preview, the plan is stale and writes nothing.
- **Deploy runs at most once.** A retry or a concurrent call returns the first outcome and never adds a second revision.
- **Deploy verifies.** The observed pool under the new monitor must equal what the plan predicted.
- **History is never rewritten.** Restoring revision 1 plans a new revision 3 from revision 1's monitor.
- **Desired and observed are separate.** Desired is the deployed monitor; observed is computed from the fixtures under it.
- **Labs are isolated.** Each lab has its own revisions. Another lab's plan id answers exactly like an unknown one.
- Roles: everyone signed in can read; operators and admins can plan and deploy. The kill switch stops both.

## Not in scope

Hysteresis or hold-down for any health decision, an SD-WAN scenario driven by server-side fixtures (the SD-WAN panel still takes typed numbers), approvals for learner deploys (this is a simulator-only exercise), and persistence across a restart (revisions are in memory).
