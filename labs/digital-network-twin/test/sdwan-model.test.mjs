import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSdwan } from '../server/adapters/sdwan-model.mjs';

const healthy = { latencyMs: 40, jitterMs: 5, lossPct: 0.1 };
const policy = { preferred: 'wan1', backup: 'wan2', thresholds: { latencyMs: 100, jitterMs: 20, lossPct: 1 }, failback: 'immediate' };

test('SD-WAN evaluates preferred, failover, no eligible path, and recovery', () => {
  const choose = (wan1, wan2, previous) => evaluateSdwan({ policy, observations: { wan1, wan2 }, previous });
  assert.equal(choose(policy.thresholds, healthy).selected, 'wan1');
  const breach = choose({ ...healthy, jitterMs: 21, lossPct: 2 }, healthy, 'wan1');
  assert.equal(breach.selected, 'wan2');
  assert.deepEqual(breach.evidence[0].breaches, ['jitterMs', 'lossPct']);
  assert.equal(choose(null, { ...healthy, latencyMs: 101 }, 'wan2').selected, null);
  assert.equal(choose(healthy, healthy, 'wan2').reason, 'return_to_preferred');
});

test('sticky backup retains a healthy path but leaves it when it becomes ineligible', () => {
  const sticky = { ...policy, failback: 'sticky' };
  const choose = (wan2) => evaluateSdwan({ policy: sticky, observations: { wan1: healthy, wan2 }, previous: 'wan2' });
  assert.equal(choose(healthy).reason, 'sticky_backup');
  assert.equal(choose(null).selected, 'wan1');
});

test('invalid samples fail rather than looking healthy', () => {
  assert.throws(() => evaluateSdwan({ policy, observations: { wan1: { ...healthy, lossPct: 101 } } }), /invalid_observation/);
});

// The complete decision table, written out by hand. Each row is the expected outcome for one situation, stated in terms of
// roles (P = the preferred uplink, B = the backup), so a change to the rules has to change a row on purpose.
//   [preferred healthy, backup healthy, previous path, failback policy] -> [selected role, reason]
const TABLE = [
  // previous = nothing yet
  [true,  true,  null, 'immediate', 'P', 'preferred_healthy'],
  [true,  true,  null, 'sticky',    'P', 'preferred_healthy'],
  [true,  false, null, 'immediate', 'P', 'preferred_healthy'],
  [true,  false, null, 'sticky',    'P', 'preferred_healthy'],
  [false, true,  null, 'immediate', 'B', 'preferred_ineligible'],
  [false, true,  null, 'sticky',    'B', 'preferred_ineligible'],
  [false, false, null, 'immediate', null, 'no_eligible_uplink'],
  [false, false, null, 'sticky',    null, 'no_eligible_uplink'],
  // previous = the preferred uplink
  [true,  true,  'P', 'immediate', 'P', 'preferred_healthy'],
  [true,  true,  'P', 'sticky',    'P', 'preferred_healthy'],
  [true,  false, 'P', 'immediate', 'P', 'preferred_healthy'],
  [true,  false, 'P', 'sticky',    'P', 'preferred_healthy'],
  [false, true,  'P', 'immediate', 'B', 'preferred_ineligible'],
  [false, true,  'P', 'sticky',    'B', 'preferred_ineligible'],
  [false, false, 'P', 'immediate', null, 'no_eligible_uplink'],
  [false, false, 'P', 'sticky',    null, 'no_eligible_uplink'],
  // previous = the backup uplink
  [true,  true,  'B', 'immediate', 'P', 'return_to_preferred'],
  [true,  true,  'B', 'sticky',    'B', 'sticky_backup'],
  [true,  false, 'B', 'immediate', 'P', 'return_to_preferred'],
  [true,  false, 'B', 'sticky',    'P', 'return_to_preferred'],   // the backup went bad: go back to the preferred uplink
  [false, true,  'B', 'immediate', 'B', 'preferred_ineligible'],
  [false, true,  'B', 'sticky',    'B', 'preferred_ineligible'],
  [false, false, 'B', 'immediate', null, 'no_eligible_uplink'],
  [false, false, 'B', 'sticky',    null, 'no_eligible_uplink']    // both bad: select neither
];

test('decision table: the selected uplink and the reason are exactly as written, for both uplink assignments and both ways of being unhealthy', () => {
  assert.equal(TABLE.length, 24, '2 x 2 health states x 3 previous paths x 2 failback policies');
  const bad = { latencyMs: 500, jitterMs: 5, lossPct: 0.1 };
  let cases = 0;
  for (const preferred of ['wan1', 'wan2']) {
    const backup = preferred === 'wan1' ? 'wan2' : 'wan1';
    const named = role => (role === null ? null : role === 'P' ? preferred : backup);
    for (const [pOk, bOk, prev, failback, role, reason] of TABLE) {
      // An unhealthy uplink can be one that breaches a threshold or one with no observation at all. Both must give the same answer.
      for (const unhealthy of [bad, null]) {
        const observations = { [preferred]: pOk ? healthy : unhealthy, [backup]: bOk ? healthy : unhealthy };
        const r = evaluateSdwan({ policy: { preferred, backup, failback, thresholds: policy.thresholds }, observations, previous: named(prev) });
        const label = JSON.stringify({ preferred, failback, previous: named(prev), preferredHealthy: pOk, backupHealthy: bOk, unhealthy: unhealthy === null ? 'missing' : 'breach' });
        assert.equal(r.selected, named(role), `selected uplink: ${label}`);
        assert.equal(r.reason, reason, `reason: ${label}`);
        assert.deepEqual(r.evidence.map(e => e.path), [preferred, backup], label);
        assert.deepEqual(r.evidence.map(e => e.healthy), [pOk, bOk], label);
        cases++;
      }
    }
  }
  assert.equal(cases, 96);
});

test('sticky edge cases, explicitly: backup turns bad with the preferred healthy, both bad, and the cases around them', () => {
  const sticky = { ...policy, failback: 'sticky' };
  const run = (wan1, wan2, previous) => evaluateSdwan({ policy: sticky, observations: { wan1, wan2 }, previous });
  const bad = { ...healthy, lossPct: 5 };
  // On the backup, the backup becomes unhealthy and the preferred is healthy: return to the preferred uplink.
  const back = run(healthy, bad, 'wan2');
  assert.equal(back.selected, 'wan1'); assert.equal(back.reason, 'return_to_preferred');
  assert.deepEqual(back.evidence.map(e => [e.path, e.healthy, e.breaches]), [['wan1', true, []], ['wan2', false, ['lossPct']]]);
  // The same, when the backup stops being observed at all.
  assert.deepEqual([run(healthy, null, 'wan2').selected, run(healthy, null, 'wan2').reason], ['wan1', 'return_to_preferred']);
  // On the backup, both are unhealthy: select neither, and say so.
  const none = run(bad, bad, 'wan2');
  assert.equal(none.selected, null); assert.equal(none.reason, 'no_eligible_uplink');
  assert.equal(run(null, null, 'wan2').selected, null);
  // Sticky still holds a healthy backup while the preferred is healthy, and does not hold an unhealthy one.
  assert.deepEqual([run(healthy, healthy, 'wan2').selected, run(healthy, healthy, 'wan2').reason], ['wan2', 'sticky_backup']);
  assert.deepEqual([run(bad, healthy, 'wan2').selected, run(bad, healthy, 'wan2').reason], ['wan2', 'preferred_ineligible']);
  // Sticky only applies when the previous path was the backup.
  assert.equal(run(healthy, healthy, 'wan1').selected, 'wan1');
  assert.equal(run(healthy, healthy, null).selected, 'wan1');
  // With immediate failback the same healthy pair returns to the preferred uplink.
  assert.deepEqual([evaluateSdwan({ policy, observations: { wan1: healthy, wan2: healthy }, previous: 'wan2' }).selected], ['wan1']);
});

test('a missing observation is unhealthy with a named breach', () => {
  const r = evaluateSdwan({ policy, observations: { wan1: null, wan2: healthy } });
  assert.deepEqual(r.evidence[0], { path: 'wan1', healthy: false, sample: null, breaches: ['missing_observation'] });
});

test('threshold boundary: a sample exactly at a threshold is healthy and anything above it is a breach, for every metric', () => {
  for (const metric of ['latencyMs', 'jitterMs', 'lossPct']) {
    const at = { ...healthy, [metric]: policy.thresholds[metric] };
    const above = { ...healthy, [metric]: policy.thresholds[metric] + 0.001 };
    const onAt = evaluateSdwan({ policy, observations: { wan1: at, wan2: healthy } });
    assert.deepEqual([onAt.selected, onAt.reason, onAt.evidence[0].healthy, onAt.evidence[0].breaches], ['wan1', 'preferred_healthy', true, []], `${metric} at its threshold`);
    const onAbove = evaluateSdwan({ policy, observations: { wan1: above, wan2: healthy } });
    assert.deepEqual([onAbove.selected, onAbove.reason, onAbove.evidence[0].breaches], ['wan2', 'preferred_ineligible', [metric]], `${metric} just above its threshold`);
  }
  const allAt = evaluateSdwan({ policy, observations: { wan1: policy.thresholds, wan2: null } });
  assert.deepEqual([allAt.selected, allAt.reason], ['wan1', 'preferred_healthy'], 'all three metrics exactly at their thresholds');
});

test('policy guard: a missing, null, array, or other non-object policy throws the named invalid_policy error when the model is called directly', () => {
  const named = (e) => e instanceof Error && !(e instanceof TypeError) && e.message === 'invalid_policy';
  for (const bad of [undefined, null, [], [policy], 'wan1', '', 7, 0, true, false, () => policy, Symbol('p')]) assert.throws(() => evaluateSdwan({ policy: bad, observations: {} }), named, String(typeof bad === 'symbol' ? 'symbol' : bad));
  assert.throws(() => evaluateSdwan(), named, 'no arguments');
  assert.throws(() => evaluateSdwan({}), named, 'no policy key');
  // The other input errors keep their own names, so invalid_policy means only "this is not a policy".
  assert.throws(() => evaluateSdwan({ policy: {}, observations: {} }), /invalid_uplinks/);
  assert.throws(() => evaluateSdwan({ policy: { ...policy, thresholds: undefined }, observations: {} }), /invalid_threshold/);
  assert.throws(() => evaluateSdwan({ policy, observations: { wan1: { ...healthy, latencyMs: '40' }, wan2: healthy } }), /invalid_observation/);
});
