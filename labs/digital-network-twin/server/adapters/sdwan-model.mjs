const METRICS = ['latencyMs', 'jitterMs', 'lossPct'];

// One synthetic observation per uplink. No clocks, probes, or vendor calls.
export function evaluateSdwan({ policy, observations, previous = null } = {}) {
  // Callers other than the HTTP route may pass anything. A missing, null, array, or other non-object policy is a named input
  // error, not a TypeError, and not an invalid_uplinks error (the uplinks are inside the policy, so they cannot be judged).
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('invalid_policy');
  const { preferred, backup, thresholds, failback } = policy;
  const paths = [preferred, backup];
  if (new Set(paths).size !== 2 || !paths.every(path => ['wan1', 'wan2'].includes(path))) throw new Error('invalid_uplinks');
  if (!['immediate', 'sticky'].includes(failback)) throw new Error('invalid_failback_policy');
  if (previous !== null && !paths.includes(previous)) throw new Error('invalid_previous_path');
  for (const metric of METRICS) {
    if (!valid(metric, thresholds?.[metric])) throw new Error('invalid_threshold');
  }
  const evidence = paths.map(path => {
    const sample = observations?.[path];
    if (sample == null) return { path, healthy: false, sample: null, breaches: ['missing_observation'] };
    const values = Object.fromEntries(METRICS.map(metric => {
      if (!valid(metric, sample[metric])) throw new Error('invalid_observation');
      return [metric, sample[metric]];
    }));
    const breaches = METRICS.filter(metric => values[metric] > thresholds[metric]);
    return { path, healthy: breaches.length === 0, sample: values, breaches };
  });
  const [primary, secondary] = evidence;
  let selected = null;
  let reason = 'no_eligible_uplink';
  if (previous === backup && secondary.healthy && primary.healthy && failback === 'sticky') {
    selected = backup;
    reason = 'sticky_backup';
  } else if (primary.healthy) {
    selected = preferred;
    reason = previous === backup ? 'return_to_preferred' : 'preferred_healthy';
  } else if (secondary.healthy) {
    selected = backup;
    reason = 'preferred_ineligible';
  }
  return { selected, reason, evidence };
}

function valid(metric, value) {
  return Number.isFinite(value) && value >= 0 && (metric !== 'lossPct' || value <= 100);
}
