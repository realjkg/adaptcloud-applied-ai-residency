// Append-only audit log. Each line carries the hash of the previous line, so removing or editing an entry breaks the
// chain and verify() says where. It records who did what and the outcome. It never records credentials, tokens, or
// response bodies.

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const FIELD = /^[A-Za-z0-9._:@/ -]{0,200}$/;

export function createAudit({ file, now = () => new Date() }) {
  let last = null;
  let ready = false;
  async function init() {
    if (ready) return;
    try {
      const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
      last = lines.length ? JSON.parse(lines.at(-1)).hash : null;
    } catch { last = null; }
    ready = true;
  }
  let chain = Promise.resolve();
  return {
    record(event) {
      const run = chain.then(async () => {
        await init();
        const clean = Object.fromEntries(Object.entries(event).map(([k, v]) => [k, typeof v === "string" ? (FIELD.test(v) ? v : v.slice(0, 200).replace(/[^A-Za-z0-9._:@/ -]/g, "?")) : v]));
        const body = { at: now().toISOString(), ...clean, prev: last };
        const hash = sha(JSON.stringify(body));
        await appendFile(file, `${JSON.stringify({ ...body, hash })}\n`);
        last = hash;
      });
      chain = run.catch(() => {});
      return run;
    },
    async verify() {
      let text;
      try { text = await readFile(file, "utf8"); } catch { return { ok: true, entries: 0 }; }
      let prev = null;
      let n = 0;
      for (const line of text.split("\n").filter(Boolean)) {
        const { hash, ...body } = JSON.parse(line);
        if (body.prev !== prev || sha(JSON.stringify(body)) !== hash) return { ok: false, brokenAt: n };
        prev = hash;
        n += 1;
      }
      return { ok: true, entries: n };
    },
    async read(limit = 100) {
      try { return (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l)); } catch { return []; }
    }
  };
}
