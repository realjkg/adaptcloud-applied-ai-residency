#!/usr/bin/env node
// Writes a draw.io file for a twin config or a snapshot, for editing in draw.io, import into Lucidchart, or export to Visio.
// usage: export-drawio.mjs [--config=path | --snapshot=path] [--out=file.drawio]

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSnapshot } from "./snapshot.mjs";
import { snapshotToDrawio } from "../viewer/drawio.js";
import { validateSnapshot } from "../viewer/snapshot.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (argv, name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export async function main(argv) {
  const snapPath = flag(argv, "snapshot");
  let snapshot;
  if (snapPath) {
    snapshot = JSON.parse(await readFile(snapPath, "utf8"));
    const problems = validateSnapshot(snapshot);
    if (problems.length) { console.error(`invalid snapshot: ${problems.join("; ")}`); return 1; }
  } else {
    const config = JSON.parse(await readFile(flag(argv, "config") ?? join(HERE, "..", "config", "twin-config.json"), "utf8"));
    snapshot = await buildSnapshot(config, { snapshotId: "EXPORT", capturedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), label: "Export" });
  }
  const xml = snapshotToDrawio(snapshot);
  const out = flag(argv, "out");
  if (out) await writeFile(out, xml); else process.stdout.write(xml);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
