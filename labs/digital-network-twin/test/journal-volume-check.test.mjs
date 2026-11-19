import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPhase, writePhase } from "../tools/journal-volume-check.mjs";

test("the volume check passes on a local directory, and verify passes in a fresh process view of the same directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twin-vol-"));
  const w = await writePhase(dir);
  assert.equal(w.ok, true, JSON.stringify(w.checks.filter((c) => !c.pass)));
  const v = await verifyPhase(dir, { requireDifferentHost: false });
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.pass)));
  const sameHost = await verifyPhase(dir);
  assert.equal(sameHost.ok, false, "verify on the same host is not a task replacement");
  assert.deepEqual(sameHost.checks.filter((c) => !c.pass).map((c) => c.name), ["the replacement is a different task"]);
  rmSync(dir, { recursive: true });
});

test("verify fails on a volume that lost the marker or the journal, and when records were tampered with", async () => {
  const empty = mkdtempSync(join(tmpdir(), "twin-vol-"));
  assert.equal((await verifyPhase(empty)).ok, false);

  const dir = mkdtempSync(join(tmpdir(), "twin-vol-"));
  const w = await writePhase(dir);
  writeFileSync(join(dir, "commit-journal", `${w.marker.id}.job.json`), "{}");
  await assert.rejects(verifyPhase(dir));

  const other = mkdtempSync(join(tmpdir(), "twin-vol-"));
  const w2 = await writePhase(other);
  const fresh = mkdtempSync(join(tmpdir(), "twin-vol-"));
  writeFileSync(join(fresh, "volume-check.json"), JSON.stringify(w2.marker));
  const lost = await verifyPhase(fresh).catch(() => ({ ok: false }));
  assert.equal(lost.ok, false, "a marker without the journal behind it is a failure");
});
