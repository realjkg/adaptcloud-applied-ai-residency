// Contract every transport adapter must satisfy before it can be used by the provisioning engine.
// The simulator runs it, and so does the live transport against a fake of the vendor API. A real adapter must also
// pass it against a disposable lab tenant before it is trusted.
//
// makeTransport() returns { transport, seedUnmanaged(key, attributes) }.
// fixtures names three related objects: a monitor, a pool that uses `<pool>-monitor`, and a pool member.

import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_FIXTURES = {
  pool: { key: { vendor: "f5", object: "pool", name: "contract-pool" }, attributes: { method: "round-robin" } },
  monitor: { key: { vendor: "f5", object: "monitor", name: "contract-pool-monitor" }, attributes: { type: "http" } },
  member: { key: { vendor: "f5", object: "pool-member", name: "10.30.0.99:8080" }, attributes: { pool: "contract-pool" } }
};

export function runTransportContract(label, makeTransport, fixtures = DEFAULT_FIXTURES) {
  const { pool, monitor, member } = fixtures;
  const firstKey = Object.keys(monitor.attributes)[0];

  test(`${label}: read returns null for a missing object`, async () => {
    const { transport } = makeTransport();
    assert.equal(await transport.read(pool.key, pool.attributes), null);
  });

  test(`${label}: create then read returns the attributes and owner`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor.key, monitor.attributes, "owner-a");
    const entry = await transport.read(monitor.key, monitor.attributes);
    assert.deepEqual(entry.attributes, monitor.attributes);
    assert.equal(entry.managedBy, "owner-a");
  });

  test(`${label}: read returns a copy, so a caller cannot change stored state`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor.key, monitor.attributes, "owner-a");
    (await transport.read(monitor.key, monitor.attributes)).attributes[firstKey] = "changed";
    assert.deepEqual((await transport.read(monitor.key, monitor.attributes)).attributes, monitor.attributes);
  });

  test(`${label}: creating an existing object fails instead of overwriting`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor.key, monitor.attributes, "owner-a");
    await assert.rejects(() => transport.create(monitor.key, { ...monitor.attributes, [firstKey]: "changed" }, "owner-a"));
    assert.deepEqual((await transport.read(monitor.key, monitor.attributes)).attributes, monitor.attributes);
  });

  test(`${label}: deleting a missing object succeeds as not_found`, async () => {
    const { transport } = makeTransport();
    assert.deepEqual(await transport.delete(pool.key, "owner-a", pool.attributes), { ok: true, outcome: "not_found" });
  });

  test(`${label}: an object owned by someone else is never deleted`, async () => {
    const { transport, seedUnmanaged } = makeTransport();
    seedUnmanaged(pool.key, pool.attributes);
    assert.deepEqual(await transport.delete(pool.key, "owner-a", pool.attributes), { ok: false, reason: "unmanaged_object" });
    assert.ok(await transport.read(pool.key, pool.attributes), "the unmanaged object must survive");
  });

  test(`${label}: an object that is still referenced is not deleted`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor.key, monitor.attributes, "owner-a");
    await transport.create(pool.key, pool.attributes, "owner-a");
    await transport.create(member.key, member.attributes, "owner-a");
    assert.deepEqual(await transport.delete(pool.key, "owner-a", pool.attributes), { ok: false, reason: "in_use" });
    assert.deepEqual(await transport.delete(monitor.key, "owner-a", monitor.attributes), { ok: false, reason: "in_use" });
    assert.equal((await transport.delete(member.key, "owner-a", member.attributes)).outcome, "deleted");
    assert.equal((await transport.delete(pool.key, "owner-a", pool.attributes)).outcome, "deleted");
    assert.equal((await transport.delete(monitor.key, "owner-a", monitor.attributes)).outcome, "deleted");
  });
}
