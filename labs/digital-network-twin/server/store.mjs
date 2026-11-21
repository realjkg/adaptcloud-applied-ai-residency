// Snapshot store. Content-addressed and immutable: a snapshot is saved as <sha256 of its bytes>.json and is never
// rewritten. An append-only index lists what was saved, when, and for WHICH SCOPE (a lab, or "live").
//
// A content hash proves integrity, not permission. Every listing and every read names a scope and is answered from index
// rows for that scope only. Identical bytes saved by two scopes share one object file and have two index rows, so neither
// scope can see that the other has it. A row without a scope (an older record) belongs to no one: it is excluded from every
// view until a trusted migration calls assignScope(). It is never defaulted to shared.
//
// Reads re-hash the bytes, so a changed or damaged file is reported, not served. Retention removes index rows by age per
// scope, never a held snapshot, always keeps the newest keepMin, and deletes an object file only when no row refers to it.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSnapshot } from "../viewer/snapshot.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const HEX = /^[0-9a-f]{64}$/;
const SCOPE = /^[A-Za-z0-9._-]{1,64}$/;
const needScope = (scope) => { if (typeof scope !== "string" || !SCOPE.test(scope)) throw new Error("scope_required"); return scope; };

export function createSnapshotStore({ dir }) {
  const objects = join(dir, "objects");
  const indexFile = join(dir, "index.jsonl");
  const holdsFile = join(dir, "holds.json");

  async function rows() {
    let text;
    try { text = await readFile(indexFile, "utf8"); } catch { return []; }
    const all = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const removed = new Set(all.filter((r) => r.removed).map((r) => `${r.scope ?? ""}|${r.digest}|${r.snapshotId}`));
    return all.filter((r) => !r.removed && !removed.has(`${r.scope ?? ""}|${r.digest}|${r.snapshotId}`));
  }
  const holdKey = (scope, digest) => `${scope}:${digest}`;
  async function holdSet() { try { return new Set(JSON.parse(await readFile(holdsFile, "utf8"))); } catch { return new Set(); } }

  return {
    /** Saves a validated snapshot for one scope. Saving the same bytes again for the same scope is a no-op. */
    async save(snapshot, { savedAt, savedBy, scope }) {
      needScope(scope);
      const problems = validateSnapshot(snapshot);
      if (problems.length > 0) throw new Error(`refused to store an invalid snapshot: ${problems.join("; ")}`);
      const text = `${JSON.stringify(snapshot, null, 2)}\n`;
      const digest = sha(text);
      await mkdir(objects, { recursive: true });
      const existing = (await rows()).find((e) => e.digest === digest && e.scope === scope);
      if (existing) return existing;
      try { await writeFile(join(objects, `${digest}.json`), text, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const entry = { snapshotId: snapshot.snapshotId, digest, scope, capturedAt: snapshot.capturedAt, label: snapshot.label, synthetic: snapshot.synthetic, sourceKind: snapshot.source.kind, savedAt, savedBy };
      await appendFile(indexFile, `${JSON.stringify(entry)}\n`);
      return entry;
    },

    /** Metadata for one scope only. */
    async list({ scope }) {
      needScope(scope);
      const held = await holdSet();
      return (await rows()).filter((r) => r.scope === scope).map((r) => ({ ...r, hold: held.has(holdKey(scope, r.digest)) })).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    },

    /** Returns the snapshot only if the scope has an index row for it. Anything else is "not found", whether or not the file exists. */
    async read(digest, { scope }) {
      needScope(scope);
      if (!HEX.test(digest)) throw new Error("not_found");
      // The file read is named by the index row (our own data), not by the request's text.
      const row = (await rows()).find((r) => r.digest === digest && r.scope === scope);
      if (!row) throw new Error("not_found");
      return this.readTrusted(row.digest);
    },

    /** For trusted tools only (integrity checks, migration). Not reachable from the API. */
    async readTrusted(digest) {
      if (!HEX.test(digest)) throw new Error("not a digest");
      const text = await readFile(join(objects, `${digest}.json`), "utf8");
      if (sha(text) !== digest) throw new Error("stored snapshot does not match its digest");
      return { text, snapshot: JSON.parse(text) };
    },

    async setHold(digest, on, { scope }) {
      needScope(scope);
      if (!HEX.test(digest) || !(await rows()).some((r) => r.digest === digest && r.scope === scope)) throw new Error("not_found");
      const held = await holdSet();
      if (on) held.add(holdKey(scope, digest)); else held.delete(holdKey(scope, digest));
      await mkdir(dir, { recursive: true });
      await writeFile(holdsFile, JSON.stringify([...held].sort()));
    },

    /** Removes snapshots older than keepDays in one scope, except held ones and that scope's newest keepMin. */
    async applyRetention({ now, keepDays, keepMin, scope }) {
      needScope(scope);
      const mine = await this.list({ scope });
      const newest = new Set(mine.slice(-keepMin).map((r) => r.digest));
      const cutoff = now.getTime() - keepDays * 86_400_000;
      const doomed = mine.filter((r) => !r.hold && !newest.has(r.digest) && Date.parse(r.capturedAt) < cutoff);
      for (const r of doomed) {
        await appendFile(indexFile, `${JSON.stringify({ removed: true, digest: r.digest, snapshotId: r.snapshotId, scope, removedAt: now.toISOString() })}\n`);
        if (!(await rows()).some((e) => e.digest === r.digest)) await rm(join(objects, `${r.digest}.json`), { force: true });
      }
      return doomed.map((r) => r.snapshotId);
    },

    /** Records with no scope. They appear in no view until assignScope() is called by a trusted migration. */
    async unscoped() { const all = await rows(); const owned = new Set(all.filter((r) => r.scope !== undefined).map((r) => `${r.digest}|${r.snapshotId}`)); return all.filter((r) => r.scope === undefined && !owned.has(`${r.digest}|${r.snapshotId}`)).map((r) => ({ snapshotId: r.snapshotId, digest: r.digest, capturedAt: r.capturedAt })); },

    /** Trusted migration only: gives an unscoped record an owner. Not exposed through the API. */
    async assignScope(digest, scope) {
      needScope(scope);
      const legacy = (await rows()).find((r) => r.digest === digest && r.scope === undefined);
      if (!legacy) throw new Error("no_unscoped_record");
      await appendFile(indexFile, `${JSON.stringify({ ...legacy, scope, migratedAt: new Date().toISOString() })}\n`);
    },

    async verifyAll() {
      const bad = [];
      for (const r of await rows()) { try { await this.readTrusted(r.digest); } catch { bad.push(r.snapshotId); } }
      return [...new Set(bad)];
    },
    async count() { try { return (await readdir(objects)).length; } catch { return 0; } }
  };
}
