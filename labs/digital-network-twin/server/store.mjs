// Snapshot store. Content-addressed and immutable: a snapshot is saved as <sha256 of its bytes>.json and is never
// rewritten. An append-only index lists what was saved and when. Reads re-hash the bytes, so a changed or damaged file
// is reported, not served. Retention removes index entries and unreferenced files by age, never a held snapshot, and
// always keeps a minimum number of the newest. A different backend (object storage with write-once retention) can
// implement the same methods.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSnapshot } from "../viewer/snapshot.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const HEX = /^[0-9a-f]{64}$/;

export function createSnapshotStore({ dir }) {
  const objects = join(dir, "objects");
  const indexFile = join(dir, "index.jsonl");

  async function entries() {
    let text;
    try { text = await readFile(indexFile, "utf8"); } catch { return []; }
    const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const removed = new Set(rows.filter((r) => r.removed).map((r) => r.digest + r.snapshotId));
    return rows.filter((r) => !r.removed && !removed.has(r.digest + r.snapshotId));
  }

  return {
    /** Saves a validated snapshot. Saving the same bytes again is a no-op that returns the existing entry. */
    async save(snapshot, { savedAt, savedBy }) {
      const problems = validateSnapshot(snapshot);
      if (problems.length > 0) throw new Error(`refused to store an invalid snapshot: ${problems.join("; ")}`);
      const text = `${JSON.stringify(snapshot, null, 2)}\n`;
      const digest = sha(text);
      await mkdir(objects, { recursive: true });
      const existing = (await entries()).find((e) => e.digest === digest);
      if (existing) return existing;
      try { await writeFile(join(objects, `${digest}.json`), text, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const entry = { snapshotId: snapshot.snapshotId, digest, capturedAt: snapshot.capturedAt, label: snapshot.label, synthetic: snapshot.synthetic, sourceKind: snapshot.source.kind, savedAt, savedBy, hold: false };
      await appendFile(indexFile, `${JSON.stringify(entry)}\n`);
      return entry;
    },

    async list() {
      const rows = await entries();
      const held = await this.holds();
      return rows.map((r) => ({ ...r, hold: held.has(r.digest) })).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    },

    /** Returns the snapshot, or throws if the stored bytes no longer match their address. */
    async read(digest) {
      if (!HEX.test(digest)) throw new Error("not a digest");
      const text = await readFile(join(objects, `${digest}.json`), "utf8");
      if (sha(text) !== digest) throw new Error("stored snapshot does not match its digest");
      return { text, snapshot: JSON.parse(text) };
    },

    async holds() {
      try { return new Set(JSON.parse(await readFile(join(dir, "holds.json"), "utf8"))); } catch { return new Set(); }
    },

    async setHold(digest, on) {
      if (!HEX.test(digest)) throw new Error("not a digest");
      const held = await this.holds();
      if (on) held.add(digest); else held.delete(digest);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "holds.json"), JSON.stringify([...held].sort()));
    },

    /** Removes snapshots older than keepDays, except held ones and the newest keepMin. Returns what was removed. */
    async applyRetention({ now, keepDays, keepMin }) {
      const rows = await this.list();
      const newest = new Set(rows.slice(-keepMin).map((r) => r.digest));
      const cutoff = now.getTime() - keepDays * 86_400_000;
      const doomed = rows.filter((r) => !r.hold && !newest.has(r.digest) && Date.parse(r.capturedAt) < cutoff);
      for (const r of doomed) {
        await appendFile(indexFile, `${JSON.stringify({ removed: true, digest: r.digest, snapshotId: r.snapshotId, removedAt: now.toISOString() })}\n`);
        const stillUsed = (await entries()).some((e) => e.digest === r.digest);
        if (!stillUsed) await rm(join(objects, `${r.digest}.json`), { force: true });
      }
      return doomed.map((r) => r.snapshotId);
    },

    async verifyAll() {
      const bad = [];
      for (const r of await this.list()) { try { await this.read(r.digest); } catch { bad.push(r.snapshotId); } }
      return bad;
    },
    async count() { try { return (await readdir(objects)).length; } catch { return 0; } }
  };
}
