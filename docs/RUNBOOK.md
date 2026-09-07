# Operational runbook

This runbook covers the shared service boundary. Scenario owners must add customer-specific escalation contacts, data rules, SLOs, and recovery objectives before deployment. Never paste request bodies, prompts, credentials, transaction details, or claim narratives into tickets or chat.

## Triage order

1. Confirm user impact through SLO/error-budget telemetry, not a single log line.
2. Identify the deployment digest, scenario, region, request metadata, and last healthy change.
3. Contain with the least destructive reversible action: stop a rollout, reduce concurrency, disable optional model calls, or route to deterministic/manual review.
4. Preserve immutable audit metadata and record the operator, time, reason, and action.
5. Recover, validate with synthetic smoke tests, and monitor the error budget before closing.

## Provider degradation

- Expected behavior: bounded retries for throttling or server errors, then deterministic fallback.
- Check provider error rate, latency, retry count, fallback count, and model-cost variance.
- Disable optional model calls at the platform routing layer if retries threaten the SLO or budget.
- Do not relax deterministic controls or enable an unapproved provider.

## Capacity exhaustion

- Expected behavior: the service returns `503 capacity_exceeded` with `retry-after` and does not accept more work.
- Check replica saturation, queue age, gateway rate limit, and per-scenario traffic.
- Scale within the reviewed maximum; reject load rather than allow unbounded concurrency or retry amplification.

## Audit-delivery failure

- Stop production promotion and page the security owner.
- Keep customer operations in the approved fail-closed or manual-review posture for the scenario.
- Restore the immutable sink and verify delivery with synthetic metadata. Never buffer sensitive bodies locally.

## Budget breach

- Confirm the deterministic `COST-001` finding, model/token attribution, and request-volume change.
- Reduce output caps, route eligible work deterministically, or pause optional model inference.
- A budget increase requires owner review; never suppress a security control to reduce cost.

## Rollback

- Trigger on failed readiness, canary health, SLO burn, security-policy failure, or unexpected cost regression.
- Redeploy the last verified image digest and its compatible configuration; do not rebuild an old source revision.
- Run live, ready, deterministic scenario, audit-delivery, and authorization smoke tests.

## Restore drill

- Use synthetic tenant data in an isolated environment.
- Restore from the approved backup, verify tenant isolation and evidence integrity, measure RTO/RPO, and delete drill data afterward.
- Set `BACKUP_RESTORE_TESTED=true` only in a deployment whose current storage design has passed this exercise.

## Exit evidence

Record incident timeline, customer impact, image/config versions, control behavior, cost effect, recovery measurements, follow-up owner, and prevention test. Redact sensitive data and link to governed systems of record rather than copying content.
