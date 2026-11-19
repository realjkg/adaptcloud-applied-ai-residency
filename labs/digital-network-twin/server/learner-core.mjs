// The learner service core: simulated vendors, per-lab state, and no sign-in. A lab owns its own simulated tenant, its own
// simulated devices, its own snapshots, schedule, and change history. Both entry points (the deployed OIDC service and the
// local persona test entry) build on this, so they enforce the same isolation.
//
// This module's import graph must never include the live adapters, the collectors, or anything that reads credentials from
// the environment; test/learner-isolation.test.mjs enforces it.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStory } from "../tools/snapshot.mjs";
import { LabTransport } from "../tools/lab-transport.mjs";
import { SIMULATION_POLICY } from "../tools/simulation-policy.mjs";
import { createSimulatedAdapters } from "./adapters/simulated.mjs";
import { createAudit } from "./audit.mjs";
import { createChangeService } from "./changes.mjs";
import { createOperations } from "./operations.mjs";
import { createReadiness } from "./readiness.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createSessions } from "./sessions.mjs";
import { SIMULATOR_TARGETS } from "./simulator-targets.mjs";
import { createStorageRunnerForLearners } from "./storage-runner-local.mjs";
import { createSnapshotStore } from "./store.mjs";
import { createLabPolicy, createTargetResolver } from "./target-resolution.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const stamp = (now) => now().toISOString().replace(/\D/g, "").slice(0, 14);

/**
 * @param {object} options
 * @param {string} options.dir persistent directory for this deployment
 * @param {Record<string, {members: string[], aliases: string[]}>} options.labs lab membership and the simulated devices each lab may use
 */
export async function createLearnerCore({ dir, labs, now = () => new Date(), deploymentId = "learner-simulator" }) {
  const config = JSON.parse(await readFile(join(HERE, "..", "config", "twin-config.json"), "utf8"));
  const store = createSnapshotStore({ dir: join(dir, "snapshots") });
  const audit = createAudit({ file: join(dir, "audit.jsonl"), now });
  let kill = false;
  const killSwitch = { get: () => kill, set: (v) => { kill = v; } };
  const sessions = createSessions({ now: () => now().getTime() });
  const policy = createLabPolicy(labs);

  // One simulated tenant per lab: one lab's apply is never another lab's baseline.
  const transports = new Map();
  const transportFor = (labId) => { if (!transports.has(labId)) transports.set(labId, new LabTransport()); return transports.get(labId); };
  const changes = createChangeService({ transportFor, access: policy, policy: SIMULATION_POLICY, tenantId: "lab-tenant-001", owner: config.twinId, baseline: () => config, audit, now, killSwitch: killSwitch.get });

  // Each lab gets its own synthetic history and its own collection schedule. Records carry the lab as their scope.
  const story = await buildStory();
  const names = Object.keys(story).filter((n) => n.startsWith("SYNTH-"));
  const labSnapshot = (labId, snap, extra = {}) => ({ ...snap, snapshotId: `${labId}-${snap.snapshotId}`.slice(0, 64), label: `${snap.label} (${labId})`.slice(0, 120), ...extra });
  for (const labId of Object.keys(labs)) for (const name of names) await store.save(labSnapshot(labId, JSON.parse(story[name])), { savedAt: now().toISOString(), savedBy: "seed", scope: labId });
  const schedulers = new Map();
  const schedulerFor = (user) => {
    const labId = user?.labId;
    if (typeof labId !== "string" || !Object.hasOwn(labs, labId) || !policy.member({ principalId: user.subject, contextId: labId })) return null;
    if (!schedulers.has(labId)) {
      let next = 0;
      schedulers.set(labId, createScheduler({
        intervalMs: 3_600_000, now,
        job: async () => {
          if (kill) return { ok: false, refusal: "kill_switch" };
          const snap = JSON.parse(story[names[next % names.length]]); next += 1;
          await store.save(labSnapshot(labId, snap, { snapshotId: `${labId}-SIM-${stamp(now)}-${next}`.slice(0, 64), capturedAt: now().toISOString().replace(/\.\d+Z$/, "Z"), label: `Simulated collection (${labId}): ${snap.label}`.slice(0, 120) }), { savedAt: now().toISOString(), savedBy: "scheduler", scope: labId });
          return { ok: true };
        }
      }));
    }
    return schedulers.get(labId);
  };

  const { sim, adapters } = createSimulatedAdapters();
  const resolver = createTargetResolver({ mode: "simulator", targets: SIMULATOR_TARGETS });
  const operations = createOperations({ resolver, policy, adapters, audit, now, killSwitch: killSwitch.get, transportKind: "simulator", file: join(dir, "operations.json") });
  const readiness = createReadiness({ deploymentId, storageRunner: createStorageRunnerForLearners(), operations, audit, now });
  // In a lab-scoped deployment an administrator sees only events by people enrolled in the same lab.
  const auditFilter = (user) => { const lab = typeof user.labId === "string" && Object.hasOwn(labs, user.labId) ? labs[user.labId] : null; return lab ? (e) => typeof e.actor === "string" && lab.members.includes(e.actor) : null; };
  return { store, audit, killSwitch, sessions, policy, changes, operations, readiness, schedulerFor, auditFilter, sim, transportFor, labs };
}
