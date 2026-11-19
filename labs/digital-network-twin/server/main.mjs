#!/usr/bin/env node
// Starts the control-plane service. Simulator mode (the default) uses the in-memory lab tenant, synthetic collectors
// data, and fixed personas, and binds to 127.0.0.1. Live mode needs a settings file, OpenID Connect, credentials in the
// environment, and the recorded authorization; see docs/CONTROL_PLANE.md. NOT TESTED AGAINST REAL SYSTEMS.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildStory } from "../tools/snapshot.mjs";
import { LabTransport } from "../tools/lab-transport.mjs";
import { SIMULATION_POLICY } from "../tools/provision-cli.mjs";
import { createOidc } from "./oidc.mjs";
import { collectSnapshot } from "../tools/collect/collector.mjs";
import { createLiveTransport } from "../tools/live/transport.mjs";
import { secretFromEnv } from "../tools/live/credentials.mjs";
import { createApp } from "./app.mjs";
import { createAudit } from "./audit.mjs";
import { createChangeService } from "./changes.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createSessions } from "./sessions.mjs";
import { createSnapshotStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PERSONAS = {
  viewer: { name: "Vera Viewer", roles: ["viewer"] },
  operator: { name: "Omar Operator", roles: ["operator"] },
  approver: { name: "Ana Approver", roles: ["approver"] },
  admin: { name: "Adel Admin", roles: ["admin", "approver"] }
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
  const app = createApp({ mode: "simulator", origin, sessions, personas: PERSONAS, store, scheduler, changes, audit, killSwitch });
  return { app, store, audit, scheduler, changes, sessions, transport, killSwitch };
}

/**
 * Live service. Everything comes from a settings file; nothing is defaulted toward live.
 * settings: { origin, dataDir, secureCookies, oidc, groupRoles, collector, intervalMs, retention, policy, tenantId, baselinePath }
 * Refuses to start without OpenID Connect, an https origin, and a provisioning policy that carries the recorded
 * authorization. Credentials for vendors come from the environment. NOT TESTED AGAINST REAL SYSTEMS.
 */
export async function createLiveService({ settings, env = process.env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  if (!String(settings.origin ?? "").startsWith("https://")) throw new Error("live mode needs an https origin");
  if (!settings.oidc) throw new Error("live mode needs OpenID Connect settings");
  if (!settings.dataDir) throw new Error("live mode needs dataDir");
  const config = JSON.parse(await readFile(settings.baselinePath, "utf8"));
  const store = createSnapshotStore({ dir: join(settings.dataDir, "snapshots") });
  const audit = createAudit({ file: join(settings.dataDir, "audit.jsonl"), now });
  let kill = false;
  const killSwitch = { get: () => kill || env.TWIN_PROVISION_KILL === "1", set: (v) => { kill = v; } };
  const oidc = createOidc({ config: { ...settings.oidc, redirectUri: `${settings.origin}/auth/callback`, clientSecret: settings.oidc.clientSecretEnv ? secretFromEnv(env, settings.oidc.clientSecretEnv) : undefined }, fetchImpl });
  const transport = createLiveTransport({ policy: settings.policy, env, fetchImpl });
  const changes = createChangeService({ transport, policy: settings.policy, tenantId: settings.tenantId, owner: config.twinId, baseline: () => config, audit, now, killSwitch: killSwitch.get });
  let n = 0;
  const scheduler = createScheduler({
    intervalMs: settings.intervalMs ?? 3_600_000, now,
    job: async () => {
      if (killSwitch.get()) return { ok: false, refusal: "kill_switch" };
      n += 1;
      const result = await collectSnapshot({ settings: settings.collector, env, fetchImpl, now: now(), snapshotId: `COLLECT-${now().toISOString().replace(/\D/g, "").slice(0, 14)}-${n}` });
      if (!result.ok) { await audit.record({ event: "collect.refused", actor: "scheduler", reason: result.refusal }); return result; }
      await store.save(result.snapshot, { savedAt: now().toISOString(), savedBy: "collector" });
      if (settings.retention) await store.applyRetention({ now: now(), ...settings.retention });
      await audit.record({ event: "collect.saved", actor: "scheduler", snapshot: result.snapshot.snapshotId });
      return { ok: true };
    }
  });
  const sessions = createSessions({ now: () => now().getTime() });
  const app = createApp({ mode: "live", origin: settings.origin, secureCookies: true, sessions, oidc, groupRoles: settings.groupRoles, store, scheduler, changes, audit, killSwitch });
  return { app, store, audit, scheduler, changes, sessions, killSwitch };
}

export async function main(argv) {
  const port = Number(argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3500);
  const liveFile = argv.find((a) => a.startsWith("--live="))?.slice(7);
  if (liveFile) {
    const svc = await createLiveService({ settings: JSON.parse(await readFile(liveFile, "utf8")) });
    await new Promise((resolve) => svc.app.listen(port, "127.0.0.1", resolve));
    svc.scheduler.start();
    console.log(`Control plane (live) on 127.0.0.1:${port}; put a TLS-terminating proxy in front of it`);
    return 0;
  }
  const dir = await mkdtemp(join(tmpdir(), "twin-control-"));
  const origin = `http://127.0.0.1:${port}`;
  const { app } = await createSimulatorService({ dir, origin });
  await new Promise((resolve) => app.listen(port, "127.0.0.1", resolve));
  console.log(`Control plane (simulator) on ${origin}/  data in ${dir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
