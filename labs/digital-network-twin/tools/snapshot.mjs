#!/usr/bin/env node
// Builds point-in-time topology snapshots (viewer/snapshot.js) from twin configs.
//
// This is a build step for the synthetic examples. In use, a read-only collector running inside the customer's
// environment produces snapshots in the same shape from vendor APIs. The viewer only ever reads snapshots.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGraph } from "./render-topology.mjs";
import { SNAPSHOT_SCHEMA_VERSION, stableStringify, topologyDigest, validateSnapshot } from "../viewer/snapshot.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_DIR = join(HERE, "..", "snapshots");
const lines = (label) => String(label ?? "").split("<br/>").filter(Boolean);

// What a live collector would ask each vendor for. A recommendation to confirm per platform, not a claim that it is
// configured. Nothing here was called.
const PLANNED_ACCESS = {
  paloalto: { level: "firewall or Panorama administrator with a read-only role", mode: "read-only" },
  f5: { level: "BIG-IP user with a read-only role", mode: "read-only" },
  meraki: { level: "organization read-only administrator, as a dedicated lab-only account", mode: "read-only" },
  cloudflare: { level: "account API token with read permissions on the zone", mode: "read-only" }
};

export async function buildSnapshot(config, { snapshotId, capturedAt, label, source: sourceOverride, synthetic }) {
  const graph = buildGraph(config);
  const topology = {
    groups: graph.groups.map((g) => ({ id: g.id, title: g.title, nodeIds: [...g.nodeIds] })),
    nodes: graph.nodes.map((n) => ({ id: n.id, lines: lines(n.label), vendor: n.vendor ?? "unknown", ...(n.path ? { path: n.path } : {}) })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to, lines: lines(e.label), kind: e.kind, danger: e.danger, ...(e.rule ? { rule: e.rule } : {}), ...(e.path ? { path: e.path } : {}) }))
  };
  const vendors = [...new Set(topology.nodes.map((n) => n.vendor))].filter((v) => PLANNED_ACCESS[v]).sort();
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    capturedAt,
    label,
    synthetic: synthetic ?? String(config.twinId ?? "").startsWith("SYNTH-"),
    source: sourceOverride ?? {
      kind: "synthetic-config",
      twinId: config.twinId,
      access: [],
      plannedAccess: vendors.map((vendor) => ({ vendor, ...PLANNED_ACCESS[vendor] }))
    },
    configDigest: createHash("sha256").update(stableStringify(config)).digest("hex"),
    topologyDigest: await topologyDigest(topology),
    topology
  };
  const problems = validateSnapshot(snapshot);
  if (problems.length > 0) throw new Error(`built an invalid snapshot: ${problems.join("; ")}`);
  return snapshot;
}

/** The synthetic story: a build that grows, then a proposed change. Times are fixed so output is reproducible. */
export const STORY = [
  { snapshotId: "SYNTH-SNAP-001", capturedAt: "2026-11-12T09:00:00Z", label: "Early build: firewall zones only", config: ["demo", "partial-1-ngfw.json"] },
  { snapshotId: "SYNTH-SNAP-002", capturedAt: "2026-11-14T09:00:00Z", label: "Firewall and F5 added", config: ["demo", "partial-2-ngfw-and-f5.json"] },
  { snapshotId: "SYNTH-SNAP-003", capturedAt: "2026-11-17T09:00:00Z", label: "Reference build", config: ["config", "twin-config.json"] },
  { snapshotId: "SYNTH-SNAP-004", capturedAt: "2026-11-18T09:00:00Z", label: "Proposed change: branch to pool rule", config: ["demo", "proposed-change-risky.json"] }
];

export async function buildStory() {
  const files = {};
  const index = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshots: [] };
  for (const entry of STORY) {
    const config = JSON.parse(await readFile(join(HERE, "..", ...entry.config), "utf8"));
    const snapshot = await buildSnapshot(config, entry);
    files[`${entry.snapshotId}.json`] = `${JSON.stringify(snapshot, null, 2)}\n`;
    index.snapshots.push({ id: entry.snapshotId, label: entry.label, capturedAt: entry.capturedAt, file: `${entry.snapshotId}.json` });
  }
  files["index.json"] = `${JSON.stringify(index, null, 2)}\n`;
  return files;
}

export async function main(argv) {
  if (!argv.includes("--all")) {
    console.error("usage: snapshot.mjs --all   (writes the synthetic snapshots into snapshots/)");
    return 2;
  }
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const files = await buildStory();
  for (const [name, content] of Object.entries(files)) await writeFile(join(SNAPSHOT_DIR, name), content);
  console.log(`wrote ${Object.keys(files).length} files to ${SNAPSHOT_DIR}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
