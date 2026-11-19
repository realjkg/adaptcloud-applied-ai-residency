// Learner deployment entry. Simulated only: an in-memory lab tenant, simulated vendors, fixed personas, and no code path
// to a live executor. This module's import graph must never include the live adapters, the collectors, the identity
// provider client, or anything that reads credentials from the environment; test/learner-isolation.test.mjs enforces it.
// Run it as the container entry point for learner-facing tasks, with no vendor credentials and no route to a management
// network.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildStory } from "../tools/snapshot.mjs";
import { LabTransport } from "../tools/lab-transport.mjs";
import { SIMULATION_POLICY } from "../tools/simulation-policy.mjs";
import { createSimulatedAdapters } from "./adapters/simulated.mjs";
import { SIMULATOR_TARGETS } from "./simulator-targets.mjs";
import { createLabPolicy, createTargetResolver } from "./target-resolution.mjs";
import { createApp } from "./app.mjs";
import { createAudit } from "./audit.mjs";
import { createChangeService } from "./changes.mjs";
import { createOperations } from "./operations.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createSessions } from "./sessions.mjs";
import { createSnapshotStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Each learner lab has its own members and its own simulated devices. A principal outside a lab sees nothing in it.
export const LABS = {
  "lab-a": { members: ["persona:viewer", "persona:operator", "persona:approver", "persona:admin"], aliases: ["pan-dfw-edge", "mx-aus-branch"] },
  "lab-b": { members: ["persona:operator-b", "persona:approver-b"], aliases: ["pan-aus-edge", "mx-plano-branch"] }
};

export const PERSONAS = {
  viewer: { name: "Vera Viewer", roles: ["viewer"], lab: "lab-a" },
  operator: { name: "Omar Operator", roles: ["operator"], lab: "lab-a" },
  approver: { name: "Ana Approver", roles: ["approver"], lab: "lab-a" },
  admin: { name: "Adel Admin", roles: ["admin", "approver"], lab: "lab-a" },
  "operator-b": { name: "Olga Operator", roles: ["operator"], lab: "lab-b" },
  "approver-b": { name: "Abel Approver", roles: ["approver"], lab: "lab-b" }
};

/** Builds the simulator service on a given directory. Used by the CLI and by tests. */
export async function createSimulatorService({ dir, origin, now = () => new Date() }) {
  const config = JSON.parse(await readFile(join(HERE, "..", "config", "twin-config.json"), "utf8"));
  const store = createSnapshotStore({ dir: join(dir, "snapshots") });
  const audit = createAudit({ file: join(dir, "audit.jsonl"), now });
  let kill = false;
  const killSwitch = { get: () => kill, set: (v) => { kill = v; } };
  const sessions = createSessions({ now: () => now().getTime() });
  const transport = new LabTransport();
  const changes = createChangeService({ transport, policy: SIMULATION_POLICY, tenantId: "lab-tenant-001", owner: config.twinId, baseline: () => config, audit, now, killSwitch: killSwitch.get });
  // The simulated collection saves the next synthetic snapshot. A live collector would call collectSnapshot instead.
  const story = await buildStory();
  const names = Object.keys(story).filter((n) => n.startsWith("SYNTH-"));
  let next = 0;
  const scheduler = createScheduler({
    intervalMs: 3_600_000, now,
    job: async () => {
      if (kill) return { ok: false, refusal: "kill_switch" };
      const name = names[next % names.length]; next += 1;
      const snap = JSON.parse(story[name]);
      await store.save({ ...snap, snapshotId: `SIM-${now().toISOString().replace(/\D/g, "").slice(0, 14)}-${next}`, capturedAt: now().toISOString().replace(/\.\d+Z$/, "Z"), label: `Simulated collection: ${snap.label}` }, { savedAt: now().toISOString(), savedBy: "scheduler" });
      return { ok: true };
    }
  });
  for (const name of names) await store.save(JSON.parse(story[name]), { savedAt: now().toISOString(), savedBy: "seed" });
  // Palo Alto, Meraki, and SD-WAN writes run against simulated vendors through the same approval workflow as live ones.
  const { sim, adapters } = createSimulatedAdapters();
  const resolver = createTargetResolver({ mode: "simulator", targets: SIMULATOR_TARGETS });
  const policy = createLabPolicy(LABS);
  const operations = createOperations({ resolver, policy, adapters, audit, now, killSwitch: killSwitch.get, transportKind: "simulator", file: join(dir, "operations.json") });
  const app = createApp({ mode: "simulator", origin, sessions, personas: PERSONAS, store, scheduler, changes, operations, audit, killSwitch });
  return { app, store, audit, scheduler, changes, operations, sessions, transport, killSwitch, sim };
}

export async function main(argv) {
  const port = Number(argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3500);
  // A container binds all interfaces only when told to, behind the platform's own network controls.
  const host = argv.includes("--all-interfaces") ? "0.0.0.0" : "127.0.0.1";
  const dir = await mkdtemp(join(tmpdir(), "twin-control-"));
  const origin = argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? `http://127.0.0.1:${port}`;
  const { app } = await createSimulatorService({ dir, origin });
  await new Promise((resolve) => app.listen(port, host, resolve));
  console.log(`Control plane (simulator, learner) on ${origin}/  data in ${dir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));

