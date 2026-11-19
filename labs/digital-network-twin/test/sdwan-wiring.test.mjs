import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

const good = { latencyMs: 40, jitterMs: 5, lossPct: 0.1 };
const input = () => ({ policy: { preferred: 'wan1', backup: 'wan2', failback: 'immediate', thresholds: { latencyMs: 100, jitterMs: 20, lossPct: 1 } }, observations: { wan1: { ...good }, wan2: { ...good } }, previous: null });
async function fixture(t, mode = 'simulator') {
  let origin;
  const records = new Map();
  let serial = 0;
  const sessions = {
    create(user) { const s = { id: String(++serial), user, csrf: `csrf-${serial}` }; records.set(s.id, s); return s; },
    get: id => records.get(id),
    destroy: id => records.delete(id),
    csrfOk: (s, token) => s.csrf === token
  };
  const server = createApp({ mode, origin: () => origin, sessions, oidc: mode === 'live' ? {} : null,
    personas: mode === 'simulator' ? { alice: { name: 'Alice', roles: ['viewer'], lab: 'A' }, bob: { name: 'Bob', roles: ['viewer'], lab: 'B' } } : {},
    audit: { record: async () => {} }, killSwitch: { get: () => false },
    store: { list: async () => [] }, changes: { controls: () => [], list: () => [] },
    scheduler: { status: () => ({}) }
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const s = sessions.create({ subject: 'synthetic', name: 'Synthetic', roles: ['viewer'], labId: 'A' });
  const post = async (body = input(), overrides = {}) => {
    const response = await fetch(origin + '/api/sdwan/evaluate', { method: 'POST', headers: { cookie: `sid=${s.id}`, origin, 'content-type': 'application/json', 'x-csrf-token': s.csrf, ...overrides }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { origin, sessions, post, s };
}

 test('SD-WAN HTTP authorization and request protection', async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 200);
  for (const [headers, expected] of [[{ cookie: '' }, 401], [{ 'x-csrf-token': '' }, 403], [{ origin: 'https://other.invalid' }, 403]]) assert.equal((await f.post(input(), headers)).status, expected);
  for (const [patch, expected] of [[{ roles: [] }, 403], [{ labId: null }, 404]]) {
    const s = f.sessions.create({ ...f.s.user, ...patch });
    assert.equal((await f.post(input(), { cookie: `sid=${s.id}`, 'x-csrf-token': s.csrf })).status, expected);
  }
  assert.equal((await (await fixture(t, 'live')).post()).status, 404);
});

test('SD-WAN HTTP input validation and boundary behavior', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await post(input(), { 'content-type': 'text/plain' })).status, 415);
  const invalid = [
    b => { b.policy = null; }, b => { b.observations = []; },
    b => { b.policy.backup = 'wan1'; }, b => { b.policy.preferred = 'wan3'; },
    b => { b.policy.failback = 'unknown'; }, b => { b.previous = 'wan3'; },
    b => { b.policy.thresholds.lossPct = 101; }, b => { b.policy.thresholds.jitterMs = -1; },
    b => { b.observations.wan1 = []; }, b => { b.observations.wan1.lossPct = 101; },
    b => { b.observations.wan1.latencyMs = -1; }, b => { b.observations.wan1.jitterMs = '5'; },
    b => { delete b.observations.wan1.lossPct; }
  ];
  for (const mutate of invalid) { const b = input(); mutate(b); assert.equal((await post(b)).status, 422, mutate.toString()); }
  const boundary = input(); boundary.observations.wan1 = { ...boundary.policy.thresholds };
  assert.equal((await post(boundary)).body.selected, 'wan1');
  const missing = input(); missing.observations = {};
  const result = await post(missing);
  assert.equal(result.status, 200); assert.equal(result.body.selected, null);
  assert.equal(result.body.reason, 'no_eligible_uplink');
});

test('SD-WAN UI config, failover, failback, validation, reset, logout and relogin', async t => {
  const { chromium } = await import('playwright');
  const f = await fixture(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(f.origin);
  const visible = () => page.locator('#sdwan').isVisible();
  assert.equal(await visible(), false);
  const login = async persona => {
    const r = await context.request.post(f.origin + '/auth/persona', { headers: { origin: f.origin }, data: { persona } });
    assert.equal(r.status(), 200);
    // Trigger the same operate-root redraw used after viewer sign-in, without navigating.
    await page.evaluate(() => document.querySelector('#operate-root').replaceChildren());
    await page.locator('#sdwan').waitFor({ state: 'visible' });
  };
  await login('alice');
  const form = page.getByRole('form', { name: 'SD-WAN simulation' });
  const field = name => form.locator(`[name="${name}"]`);
  const status = page.locator('#sdwan [role="status"]');
  const run = async (selected, reason) => {
    const [r] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/sdwan/evaluate' && r.request().method() === 'POST'), form.getByRole('button', { name: 'Evaluate uplinks' }).click()]);
    assert.equal(r.status(), 200); const b = await r.json();
    assert.equal(b.selected, selected); assert.equal(b.reason, reason);
    const expected = `${selected ?? 'No eligible uplink'} — ${reason.replaceAll('_', ' ')}`;
    await page.waitForFunction(text => document.querySelector('#sdwan [role="status"]').textContent === text, expected);
  };
  await run('wan1', 'preferred_healthy');
  await field('wan1.latencyMs').fill('101'); await run('wan2', 'preferred_ineligible');
  await field('wan1.latencyMs').fill('40'); await run('wan1', 'return_to_preferred');
  await field('failback').selectOption('sticky');
  await field('wan1.lossPct').fill('2'); await run('wan2', 'preferred_ineligible');
  await field('wan1.lossPct').fill('0.1'); await run('wan2', 'sticky_backup');
  await field('wan2.jitterMs').fill('21'); await run('wan1', 'return_to_preferred');
  await field('wan1.jitterMs').fill('21'); await run(null, 'no_eligible_uplink');
  await form.getByRole('button', { name: 'Reset simulation' }).click();
  await field('preferred').selectOption('wan2'); await run('wan2', 'preferred_healthy');
  await field('thresholds.latencyMs').fill('39'); await run(null, 'no_eligible_uplink');
  let requests = 0;
  const count = r => { if (new URL(r.url()).pathname === '/api/sdwan/evaluate') requests++; };
  page.on('request', count);
  await field('wan2.lossPct').fill('101');
  await form.getByRole('button', { name: 'Evaluate uplinks' }).click();
  assert.equal(await field('wan2.lossPct').evaluate(el => el.validity.rangeOverflow), true);
  assert.equal(await status.textContent(), ''); assert.equal(requests, 0);
  page.off('request', count);
  const me = await (await context.request.get(f.origin + '/api/me')).json();
  const logout = await context.request.post(f.origin + '/auth/logout', { headers: { origin: f.origin, 'x-csrf-token': me.csrf }, data: {} });
  assert.equal(logout.status(), 200);
  // The root is already empty here, and replaceChildren() on an empty node records no mutation, so give the observer a real change.
  await page.evaluate(() => document.querySelector('#operate-root').replaceChildren(document.createElement('span')));
  await page.locator('#sdwan').waitFor({ state: 'hidden' });
  await login('bob'); assert.equal(await field('preferred').inputValue(), 'wan1');
  await run('wan1', 'preferred_healthy');
});
