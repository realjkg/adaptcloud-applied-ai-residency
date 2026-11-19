// Contract every transport adapter must satisfy before it can be used by the provisioning engine.
// The simulator runs it today. A live adapter must pass the same suite against a disposable lab tenant first.
//
// makeTransport() returns { transport, seedUnmanaged(key, attributes) }.

import { test } from "node:test";
import assert from "node:assert/strict";

const pool = { vendor: "f5", object: "pool", name: "contract-pool" };
const monitor = { vendor: "f5", object: "monitor", name: "contract-pool-monitor" };
const member = { vendor: "f5", object: "pool-member", name: "10.30.0.99:8080" };

export function runTransportContract(label, makeTransport) {
  test(`${label}: read returns null for a missing object`, async () => {
    const { transport } = makeTransport();
    assert.equal(await transport.read(pool), null);
  });

  test(`${label}: create then read returns the attributes and owner`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor, { type: "http" }, "owner-a");
    const entry = await transport.read(monitor);
    assert.deepEqual(entry.attributes, { type: "http" });
    assert.equal(entry.managedBy, "owner-a");
  });

  test(`${label}: read returns a copy, so a caller cannot change stored state`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor, { type: "http" }, "owner-a");
    (await transport.read(monitor)).attributes.type = "changed";
    assert.equal((await transport.read(monitor)).attributes.type, "http");
  });

  test(`${label}: creating an existing object fails instead of overwriting`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor, { type: "http" }, "owner-a");
    await assert.rejects(() => transport.create(monitor, { type: "https" }, "owner-a"));
    assert.equal((await transport.read(monitor)).attributes.type, "http");
  });

  test(`${label}: deleting a missing object succeeds as not_found`, async () => {
    const { transport } = makeTransport();
    assert.deepEqual(await transport.delete(pool, "owner-a"), { ok: true, outcome: "not_found" });
  });

  test(`${label}: an object owned by someone else is never deleted`, async () => {
    const { transport, seedUnmanaged } = makeTransport();
    seedUnmanaged(pool, { note: "not ours" });
    assert.deepEqual(await transport.delete(pool, "owner-a"), { ok: false, reason: "unmanaged_object" });
    assert.ok(await transport.read(pool), "the unmanaged object must survive");
  });

  test(`${label}: an object that is still referenced is not deleted`, async () => {
    const { transport } = makeTransport();
    await transport.create(monitor, { type: "http" }, "owner-a");
    await transport.create(pool, { method: "round-robin" }, "owner-a");
    await transport.create(member, { pool: pool.name }, "owner-a");
    assert.deepEqual(await transport.delete(pool, "owner-a"), { ok: false, reason: "in_use" });
    assert.deepEqual(await transport.delete(monitor, "owner-a"), { ok: false, reason: "in_use" });
    assert.equal((await transport.delete(member, "owner-a")).outcome, "deleted");
    assert.equal((await transport.delete(pool, "owner-a")).outcome, "deleted");
    assert.equal((await transport.delete(monitor, "owner-a")).outcome, "deleted");
  });
}
