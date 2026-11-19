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
