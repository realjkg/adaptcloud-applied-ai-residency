#!/usr/bin/env node
// Checks that a directory behaves as the commit journal needs, and that it survives task replacement.
//
//   journal-volume-check.mjs write  --dir=<path>   on the first task: exercise the journal, leave a marker behind
//   journal-volume-check.mjs verify --dir=<path>   on a REPLACEMENT task, mounted on the same volume: confirm it survived
//
// It uses the real journal. It proves the volume behaves, not that the firewall does: it makes no vendor call and reads
// no credentials. Run `write`, replace the task, then run `verify`. Replacing means stopping the task and starting a new
// one, not restarting a process inside the same task.

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCommitJournal } from "../server/commit-journal.mjs";

const MARKER = "volume-check.json";

export async function writePhase(dir) {
  const checks = [];
  const ok = (name, pass, detail = "") => checks.push({ name, pass, detail });
  const base = join(dir, "commit-journal");
  await mkdir(base, { recursive: true });
  const journal = createCommitJournal(base);
  const id = `OP-${randomBytes(5).toString("hex").toUpperCase()}`;
  const targetFingerprint = randomBytes(32).toString("hex");
  const planDigest = randomBytes(32).toString("hex");
  const jobId = String(1 + Math.floor(Math.random() * 1e9));

  try { await journal.recordIntent({ id, targetFingerprint, planDigest }); ok("intent is written (hard link and fsync work)", true); } catch (error) { ok("intent is written (hard link and fsync work)", false, error.code ?? error.message); return report(checks, null); }
  try { await journal.recordIntent({ id, targetFingerprint, planDigest }); ok("a second intent for the same operation is refused", false, "it was accepted"); } catch (error) { ok("a second intent for the same operation is refused", error.code === "EEXIST", error.code ?? error.message); }
  await journal.recordJob(id, jobId);
  ok("the job id is written", true);
  try { await journal.recordJob(id, jobId); ok("a second job record is refused", false, "it was accepted"); } catch (error) { ok("a second job record is refused", error.code === "EEXIST", error.code ?? error.message); }
  const rec = await journal.recover({ id, targetFingerprint, planDigest });
  ok("recovery reads it back in the same task", rec.state === "job_known" && rec.jobId === jobId);
  const leftovers = (await readdir(base)).filter((n) => n.startsWith(".commit-"));
  ok("no temporary files are left behind", leftovers.length === 0, leftovers.join(","));
  const links = (await stat(join(base, `${id}.intent.json`))).nlink;
  ok("the published record is a single directory entry", links === 1, `nlink=${links}`);

  const marker = { id, targetFingerprint, planDigest, jobId, writtenAt: new Date().toISOString(), host: hostname() };
  await writeFile(join(dir, MARKER), JSON.stringify(marker), { mode: 0o600 });
  return report(checks, marker);
}

export async function verifyPhase(dir, { requireDifferentHost = true } = {}) {
  const checks = [];
  const ok = (name, pass, detail = "") => checks.push({ name, pass, detail });
  let marker;
  try { marker = JSON.parse(await readFile(join(dir, MARKER), "utf8")); } catch { ok("the marker from the first task is present", false, "missing: the volume did not persist, or this is not the same volume"); return report(checks, null); }
  ok("the marker from the first task is present", true, `written ${marker.writtenAt}`);
  const journal = createCommitJournal(join(dir, "commit-journal"));
  const rec = await journal.recover({ id: marker.id, targetFingerprint: marker.targetFingerprint, planDigest: marker.planDigest });
  ok("the intent and job id survived task replacement", rec.state === "job_known" && rec.jobId === marker.jobId, rec.state);
  try { await journal.recordIntent({ id: marker.id, targetFingerprint: marker.targetFingerprint, planDigest: marker.planDigest }); ok("a replacement task still cannot record a second intent", false, "it was accepted"); } catch (error) { ok("a replacement task still cannot record a second intent", error.code === "EEXIST", error.code ?? error.message); }
  ok("the replacement is a different task", !requireDifferentHost || marker.host === null || marker.host !== hostname(), `first host ${marker.host}, this host ${hostname()}`);
  return report(checks, marker);
}

function report(checks, marker) {
  return { ok: checks.length > 0 && checks.every((c) => c.pass), checks, marker };
}

export async function main(argv) {
  const [phase] = argv;
  const dir = argv.find((a) => a.startsWith("--dir="))?.slice(6);
  if (!["write", "verify"].includes(phase) || !dir) { console.error("usage: journal-volume-check.mjs <write|verify> --dir=<mounted volume path>"); return 2; }
  const result = phase === "write" ? await writePhase(dir) : await verifyPhase(dir);
  for (const c of result.checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  console.log(result.ok ? `\nAll checks passed. This proves the volume, not the firewall. ${phase === "write" ? "Now replace the task and run verify." : ""}` : "\nThe volume is not safe for the commit journal.");
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
