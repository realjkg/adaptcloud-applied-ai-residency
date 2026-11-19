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

// The complete decision table for a two-uplink policy: preferred x failback x previous x each uplink's state.
test('decision table: every combination keeps the safety and failback invariants', () => {
  const states = { missing: null, breach: { latencyMs: 500, jitterMs: 5, lossPct: 0.1 }, healthy };
  const names = Object.keys(states);
  let cases = 0;
  for (const preferred of ['wan1', 'wan2']) for (const failback of ['immediate', 'sticky']) for (const previous of [null, 'wan1', 'wan2'])
    for (const a of names) for (const b of names) {
      const backup = preferred === 'wan1' ? 'wan2' : 'wan1';
      const observations = { wan1: states[a], wan2: states[b] };
      const ok = path => observations[path] === healthy;
      const r = evaluateSdwan({ policy: { preferred, backup, failback, thresholds: policy.thresholds }, observations, previous });
      const label = JSON.stringify({ preferred, failback, previous, wan1: a, wan2: b, got: r.selected, reason: r.reason });
      cases++;
      if (r.selected !== null) assert.ok(ok(r.selected), `selected an unhealthy path ${label}`);
      else assert.ok(!ok('wan1') && !ok('wan2'), `no path although one is healthy ${label}`);
      if (failback === 'immediate' && ok(preferred)) assert.equal(r.selected, preferred, `immediate failback ${label}`);
      if (failback === 'sticky' && previous === backup && ok(backup)) assert.equal(r.selected, backup, `sticky left a healthy backup ${label}`);
      if (failback === 'sticky' && previous === backup && ok(backup) && ok(preferred)) assert.equal(r.reason, 'sticky_backup', label);
      if (r.selected === preferred) assert.equal(r.reason, previous === backup ? 'return_to_preferred' : 'preferred_healthy', label);
      assert.deepEqual(r.evidence.map(e => e.path), [preferred, backup], label);
      assert.deepEqual(r.evidence.map(e => e.healthy), [ok(preferred), ok(backup)], label);
    }
  assert.equal(cases, 108);
});

test('a missing observation is unhealthy with a named breach, and the threshold itself is healthy', () => {
  const r = evaluateSdwan({ policy, observations: { wan1: null, wan2: healthy } });
  assert.deepEqual(r.evidence[0], { path: 'wan1', healthy: false, sample: null, breaches: ['missing_observation'] });
  assert.equal(evaluateSdwan({ policy, observations: { wan1: policy.thresholds, wan2: null } }).reason, 'preferred_healthy');
});

test('policy guard: a missing or non-object policy is an input error, not a TypeError', () => {
  for (const bad of [undefined, null, 'wan1', 7, [], true]) assert.throws(() => evaluateSdwan({ policy: bad, observations: {} }), (e) => e instanceof Error && !(e instanceof TypeError) && e.message === 'invalid_uplinks', String(bad));
  assert.throws(() => evaluateSdwan(), (e) => !(e instanceof TypeError) && e.message === 'invalid_uplinks');
  assert.throws(() => evaluateSdwan({ policy, observations: { wan1: { ...healthy, latencyMs: '40' }, wan2: healthy } }), /invalid_observation/);
  assert.throws(() => evaluateSdwan({ policy: { ...policy, thresholds: undefined }, observations: {} }), /invalid_threshold/);
});
