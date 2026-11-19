import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LabTransport } from "../tools/lab-transport.mjs";
import { apply, destroy, plan, prepare } from "../tools/provision.mjs";
import { digestOf, evaluatePolicy, REASONS, validateApproval } from "../tools/provision-policy.mjs";
import { runRoundtrip, SIMULATION_POLICY } from "../tools/provision-cli.mjs";
import { runTransportContract } from "./transport-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const reference = () => JSON.parse(readFileSync(join(root, "config", "twin-config.json"), "utf8"));
const NOW = new Date("2026-11-19T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const seen = new Set();
/** Records the reason so the final test can prove every refusal reason is exercised. */
function expectReason(actual, expected) {
  assert.equal(actual, expected);
  seen.add(expected);
}

function setup({ policy = {}, transportOptions = {}, config = reference() } = {}) {
  const prepared = prepare(config);
  assert.ok(prepared.ok, "reference config must be healthy");
  const transport = new LabTransport(transportOptions);
  const target = { environment: "lab", tenantId: "lab-tenant-001", owner: config.twinId };
  const merged = { ...SIMULATION_POLICY, ...policy };
  const approval = (action, overrides = {}) => ({ ref: `TICKET-${action}-0001`, approver: "a.person", action, tenantId: target.tenantId, digest: prepared.digest, approvedAt: NOW.toISOString(), ...overrides });
  const base = { changeset: prepared.changeset, transport, policy: merged, target };
  return { prepared, transport, target, policy: merged, approval, base };
}

runTransportContract("LabTransport", () => {
  const transport = new LabTransport();
  return { transport, seedUnmanaged: (key, attributes) => transport.seedUnmanaged(key, attributes) };
});

test("apply then destroy leaves the tenant exactly as it started, and never touches unmanaged objects", async () => {
  const result = await runRoundtrip(reference(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.symmetric, true);
  assert.equal(result.unmanagedSurvived, true);
  assert.deepEqual(result.objects, { before: 2, afterApply: 37, afterDestroy: 2 });
  assert.equal(result.created, 35);
  assert.equal(result.deleted, 35);
});

test("policy refuses by default and for every unsafe target", () => {
  const changeset = prepare(reference()).changeset;
  const target = { environment: "lab", tenantId: "lab-tenant-001" };
  const ask = (over = {}) => evaluatePolicy({ action: "apply", policy: { ...SIMULATION_POLICY, ...(over.policy ?? {}) }, target: { ...target, ...(over.target ?? {}) }, changeset, transportKind: over.transportKind ?? "simulator", killSwitch: over.killSwitch ?? false });
  assert.equal(ask(), null);
  expectReason(evaluatePolicy({ action: "plan", policy: undefined, target, changeset, transportKind: "simulator" }), "layer_disabled");
  expectReason(ask({ policy: { enabled: false } }), "layer_disabled");
  expectReason(ask({ killSwitch: true }), "kill_switch_engaged");
  for (const environment of ["production", "staging", "prod", "Lab", ""]) expectReason(ask({ target: { environment } }), "environment_not_lab");
  expectReason(ask({ policy: { environment: "production" } }), "environment_not_lab");
  expectReason(ask({ target: { tenantId: "someone-elses-tenant" } }), "tenant_not_allowlisted");
  expectReason(ask({ policy: { allowedTenants: ["*"] } }), "wildcard_not_permitted");
  expectReason(ask({ policy: { allowedVendors: ["paloalto", "f5", "cloudflare", "*"] } }), "wildcard_not_permitted");
  expectReason(ask({ policy: { allowedVendors: ["paloalto", "f5", "cloudflare"] } }), "vendor_not_allowlisted");
  expectReason(ask({ policy: { transport: "live" } }), "transport_unavailable");
  expectReason(ask({ transportKind: "live" }), "transport_unavailable");
  expectReason(ask({ policy: { maxOperations: 10 } }), "too_many_operations");
  expectReason(evaluatePolicy({ action: "destroy", policy: { ...SIMULATION_POLICY, allowDestroy: false }, target, changeset, transportKind: "simulator" }), "destroy_not_enabled");
});

test("an unhealthy config never becomes a change set", () => {
  const config = reference();
  config.cloudflare.ssl.mode = "flexible";
  const result = prepare(config);
  assert.equal(result.ok, false);
  expectReason(result.refusal, "config_unhealthy");
});

test("approvals are bound to action, tenant, and digest, and are bounded in time", () => {
  const { prepared, approval } = setup();
  const check = (value, action = "apply") => validateApproval(value, { action, tenantId: "lab-tenant-001", digest: prepared.digest, now: NOW });
  assert.equal(check(approval("apply")), null);
  expectReason(check(undefined), "approval_required");
  expectReason(check(null), "approval_required");
  expectReason(check(approval("apply", { approvedAt: "2026-11-19T12:00:00" })), "approval_invalid");
  expectReason(check(approval("apply", { ref: "x" })), "approval_invalid");
  expectReason(check(approval("apply", { approver: "" })), "approval_invalid");
  expectReason(check("approved"), "approval_invalid");
  expectReason(check(approval("apply", { approvedAt: new Date(NOW.getTime() + 1000).toISOString() })), "approval_not_yet_valid");
  assert.equal(check(approval("apply", { approvedAt: new Date(NOW.getTime() - 24 * HOUR).toISOString() })), null, "exactly 24 hours is still valid");
  expectReason(check(approval("apply", { approvedAt: new Date(NOW.getTime() - 24 * HOUR - 1).toISOString() })), "approval_expired");
  expectReason(check(approval("destroy")), "approval_scope_mismatch");
  expectReason(check(approval("apply", { tenantId: "other" })), "approval_scope_mismatch");
  expectReason(check(approval("apply", { digest: "0".repeat(64) })), "approval_digest_mismatch");
});

test("apply needs a dry run of the exact change set, and a tampered change set is caught", async () => {
  const { base, prepared, approval } = setup();
  expectReason((await apply({ ...base, approval: approval("apply"), plannedDigest: undefined, now: NOW })).refusal, "dry_run_required");
  const tampered = structuredClone(prepared.changeset);
  tampered[3].attributes.zone = "untrust";
  expectReason((await apply({ ...base, changeset: tampered, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW })).refusal, "dry_run_required");
  // Even with a matching dry-run digest, an approval bound to the original change set does not cover the tampered one.
  const result = await apply({ ...base, changeset: tampered, approval: approval("apply"), plannedDigest: digestOf(tampered), now: NOW });
  expectReason(result.refusal, "approval_digest_mismatch");
  assert.equal(base.transport.snapshot().length, 0, "nothing may be written");
});

test("apply refuses without an approval and writes nothing", async () => {
  const { base, prepared, transport } = setup();
  const result = await apply({ ...base, approval: undefined, plannedDigest: prepared.digest, now: NOW });
  expectReason(result.refusal, "approval_required");
  assert.equal(transport.snapshot().length, 0);
});

test("apply is idempotent: a second run changes nothing", async () => {
  const { base, prepared, approval, transport } = setup();
  const first = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  assert.equal(first.ok, true);
  const before = JSON.stringify(transport.snapshot());
  const second = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  assert.deepEqual([second.ok, second.created, second.unchanged], [true, 0, 35]);
  assert.equal(JSON.stringify(transport.snapshot()), before);
});

test("an unowned object with a planned name blocks the run before any write", async () => {
  const { base, prepared, approval, transport } = setup();
  transport.seedUnmanaged({ vendor: "paloalto", object: "zone", name: "untrust" }, { note: "not ours" });
  const result = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  expectReason(result.refusal, "conflict_unmanaged");
  assert.equal(transport.snapshot().length, 1, "only the seeded object exists");
  assert.equal((await plan(base)).summary.conflict_unmanaged, 1);
});

test("drift in an owned object blocks the run before any write", async () => {
  const { base, prepared, approval, transport } = setup();
  await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  transport.state.get("cloudflare/zone-setting/ssl").attributes.value = "flexible";
  const before = JSON.stringify(transport.snapshot());
  const result = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  expectReason(result.refusal, "drift_detected");
  assert.equal(JSON.stringify(transport.snapshot()), before);
  assert.equal((await plan(base)).summary.drift, 1);
});

test("a failure part-way through rolls back only what the run created", async () => {
  const { base, prepared, approval, transport } = setup({ transportOptions: { failOn: ["f5/virtual-server/app-vs"] } });
  transport.seedUnmanaged({ vendor: "f5", object: "pool", name: "legacy-pool" }, { note: "not ours" });
  const seed = JSON.stringify(transport.snapshot());
  const result = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  expectReason(result.refusal, "operation_failed");
  assert.equal(result.rolledBack.complete, true);
  assert.equal(JSON.stringify(transport.snapshot()), seed, "the tenant must be back to its starting state");
  assert.ok(result.audit.some((row) => row.outcome === "operation_failed"));
});

test("a write that reads back wrong halts the run and rolls back", async () => {
  const { base, prepared, approval, transport } = setup({ transportOptions: { corruptOn: ["cloudflare/dns-record/app.lab.example"] } });
  const result = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  expectReason(result.refusal, "verification_failed");
  assert.equal(result.rolledBack.complete, true);
  assert.equal(transport.snapshot().length, 0);
});

test("destroy is gated like apply", async () => {
  const { base, approval } = setup({ policy: { allowDestroy: false } });
  expectReason((await destroy({ ...base, approval: approval("destroy"), now: NOW })).refusal, "destroy_not_enabled");
  const open = setup();
  expectReason((await destroy({ ...open.base, approval: undefined, now: NOW })).refusal, "approval_required");
  expectReason((await destroy({ ...open.base, approval: open.approval("apply"), now: NOW })).refusal, "approval_scope_mismatch");
});

test("destroy twice is safe, and the second run finds nothing to delete", async () => {
  const { base, prepared, approval } = setup();
  await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  const first = await destroy({ ...base, approval: approval("destroy"), now: NOW });
  const second = await destroy({ ...base, approval: approval("destroy"), now: NOW });
  assert.deepEqual([first.ok, first.deleted, second.ok, second.deleted], [true, 35, true, 0]);
});

test("destroy leaves an object this twin does not own, even with a planned name", async () => {
  const { base, prepared, approval, transport } = setup();
  await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  transport.state.get("f5/ssl-certificate/app-cert").managedBy = null;
  const result = await destroy({ ...base, approval: approval("destroy"), now: NOW });
  assert.equal(result.skipped.length, 1);
  assert.ok(await transport.read({ vendor: "f5", object: "ssl-certificate", name: "app-cert" }), "the unowned object must survive");
});

test("destroy halts instead of deleting something that is still in use", async () => {
  const { base, prepared, approval, transport } = setup();
  await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  // A wrong order (dependencies first) is what a hand-edited teardown looks like.
  const wrongOrder = [...prepared.changeset].reverse().map((op, index) => ({ ...op, order: index + 1 }));
  const result = await destroy({ ...base, changeset: wrongOrder, approval: approval("destroy", { digest: digestOf(wrongOrder) }), now: NOW });
  expectReason(result.refusal, "in_use");
  assert.ok(result.audit.some((row) => row.outcome === "in_use"));
  assert.ok(transport.snapshot().length > 0, "objects that were in use must remain");
});

test("the kill switch refuses plan, apply, and destroy", async () => {
  const { base, prepared, approval } = setup();
  const armed = { ...base, killSwitch: true };
  expectReason((await plan(armed)).refusal, "kill_switch_engaged");
  expectReason((await apply({ ...armed, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW })).refusal, "kill_switch_engaged");
  expectReason((await destroy({ ...armed, approval: approval("destroy"), now: NOW })).refusal, "kill_switch_engaged");
});

test("the audit trail and results never contain attribute values", async () => {
  const config = reference();
  config.f5.pool.method = "SENTINEL-LEAK-VALUE";
  const { base, prepared, approval } = setup({ config });
  const planned = await plan(base);
  const applied = await apply({ ...base, approval: approval("apply"), plannedDigest: prepared.digest, now: NOW });
  const destroyed = await destroy({ ...base, approval: approval("destroy"), now: NOW });
  assert.ok(applied.ok && destroyed.ok);
  for (const output of [planned, applied, destroyed]) assert.ok(!JSON.stringify(output).includes("SENTINEL-LEAK-VALUE"));
  assert.deepEqual(Object.keys(applied.audit[0]).sort(), ["action", "at", "name", "object", "order", "outcome", "vendor"]);
});

test("the change set holds references to secrets, never secrets", () => {
  const text = JSON.stringify(prepare(reference()).changeset);
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text));
  assert.ok(/secret-store:\/\//.test(text));
});

test("docs/PROVISIONING.md names every refusal reason", () => {
  const doc = readFileSync(join(root, "docs", "PROVISIONING.md"), "utf8");
  for (const reason of REASONS) assert.ok(doc.includes(`\`${reason}\``), `${reason} is missing from the doc`);
});

test("every refusal reason has a test that triggers it", () => {
  const untested = REASONS.filter((reason) => !seen.has(reason));
  assert.deepEqual(untested, [], `refusal reasons without a test: ${untested.join(", ")}`);
});

function cli(args, env = {}) {
  const result = spawnSync("node", [join(root, "tools", "provision-cli.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("CLI: roundtrip proves symmetry", () => {
  const result = cli(["roundtrip"]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.out).symmetric, true);
});

test("CLI: approval-template is invalid until a person completes it", () => {
  const template = JSON.parse(cli(["approval-template", "apply", "--tenant=lab-tenant-001"]).out);
  assert.equal(template.digest, prepare(reference()).digest);
  const reason = validateApproval(template, { action: "apply", tenantId: "lab-tenant-001", digest: template.digest, now: new Date() });
  assert.equal(reason, "approval_invalid");
});

test("CLI: refuses without a policy, and with a disabled one", () => {
  assert.equal(cli(["plan", "--tenant=lab-tenant-001"]).status, 2);
  const dir = mkdtempSync(join(tmpdir(), "twin-cli-"));
  try {
    const disabled = join(dir, "policy.json");
    writeFileSync(disabled, readFileSync(join(root, "config", "provision-policy.example.json")));
    const result = cli(["plan", `--policy=${disabled}`, "--tenant=lab-tenant-001", `--state=${join(dir, "state.json")}`]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.out).refusal, "layer_disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: plan, apply, and destroy round trip through a state file", () => {
  const dir = mkdtempSync(join(tmpdir(), "twin-cli-"));
  try {
    const policy = join(dir, "policy.json");
    const state = join(dir, "state.json");
    writeFileSync(policy, JSON.stringify({ ...SIMULATION_POLICY }));
    const common = [`--policy=${policy}`, `--state=${state}`, "--tenant=lab-tenant-001"];
    const planned = JSON.parse(cli(["plan", ...common]).out);
    assert.equal(planned.summary.create, 35);

    const approvalFile = (action) => {
      const path = join(dir, `${action}.json`);
      writeFileSync(path, JSON.stringify({ ref: `TICKET-${action}-0001`, approver: "a.person", action, tenantId: "lab-tenant-001", digest: planned.digest, approvedAt: new Date().toISOString() }));
      return `--approval=${path}`;
    };
    assert.equal(cli(["apply", ...common, approvalFile("apply")]).status, 1, "apply needs the planned digest");
    const applied = cli(["apply", ...common, approvalFile("apply"), `--planned-digest=${planned.digest}`]);
    assert.equal(applied.status, 0);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).length, 35);

    const killed = cli(["destroy", ...common, approvalFile("destroy")], { TWIN_PROVISION_KILL: "1" });
    assert.equal(JSON.parse(killed.out).refusal, "kill_switch_engaged");
    assert.equal(JSON.parse(readFileSync(state, "utf8")).length, 35, "a refused destroy must not change state");

    assert.equal(cli(["destroy", ...common, approvalFile("destroy")]).status, 0);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
