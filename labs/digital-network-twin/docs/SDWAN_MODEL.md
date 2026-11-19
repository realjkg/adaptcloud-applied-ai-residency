# SD-WAN decision model

`server/adapters/sdwan-model.mjs` decides which of two uplinks to use from one observation per uplink. It is pure: no clock, no probes, no vendor calls. A caller supplies the policy, the observations, and the previous choice.

## Inputs and errors

A policy is an object with `preferred`, `backup` (two different uplinks from `wan1` and `wan2`), `thresholds` (`latencyMs`, `jitterMs`, `lossPct`), and `failback` (`immediate` or `sticky`). Called directly, the model throws a named error for bad input and never a `TypeError`:

| Error | Meaning |
|---|---|
| `invalid_policy` | The policy is missing, `null`, an array, or any other non-object. |
| `invalid_uplinks` | The two uplinks are not two different values from `wan1` and `wan2`. |
| `invalid_failback_policy` | `failback` is not `immediate` or `sticky`. |
| `invalid_previous_path` | The previous choice is not one of the two uplinks. |
| `invalid_threshold` | A threshold is not a finite number of 0 or more (loss is also at most 100). |
| `invalid_observation` | A sample value is not a finite number in range. Strings and `Infinity` are rejected. |

The HTTP route (`POST /api/sdwan/evaluate`) is unchanged: it answers 422 `invalid_sdwan_input` for a missing or non-object policy or observations before the model is called, and 422 with the model's error name for the rest.

## Health

An uplink is healthy when every metric is **at or below** its threshold. **A sample exactly at its threshold is healthy**; only a value strictly greater than the threshold is a breach. An uplink with no observation is unhealthy, with the breach `missing_observation`.

## Decision

| Situation | Selected | Reason |
|---|---|---|
| The previous path was the backup, failback is `sticky`, and both uplinks are healthy | backup | `sticky_backup` |
| The preferred uplink is healthy (previous was the backup, any other failback or health) | preferred | `return_to_preferred` if the previous path was the backup, else `preferred_healthy` |
| Only the backup is healthy | backup | `preferred_ineligible` |
| Neither is healthy | none | `no_eligible_uplink` |

Sticky failback therefore never moves off a healthy backup while the preferred uplink is healthy, never holds an unhealthy backup, and goes back to the preferred uplink as soon as the backup is unhealthy and the preferred one is healthy.

`test/sdwan-model.test.mjs` states every row of this table by hand (24 situations, each run for both uplink assignments and for both ways of being unhealthy) and asserts the selected uplink and the reason.

## Not modelled

There is no hysteresis or hold-down: a path hovering around a threshold can change the decision on every evaluation. That needs history or time, which this model deliberately does not have.
