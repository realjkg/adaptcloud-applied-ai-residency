#!/usr/bin/env node
// Starts the control-plane service. Simulator mode (the default) uses the in-memory lab tenant, synthetic collectors
// data, and fixed personas, and binds to 127.0.0.1. Live mode needs a settings file, OpenID Connect, credentials in the
// environment, and the recorded authorization; see docs/CONTROL_PLANE.md. NOT TESTED AGAINST REAL SYSTEMS.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectSnapshot } from "../tools/collect/collector.mjs";
import { createGuardedHttp } from "../tools/live/guarded-http.mjs";
import { secretFromEnv } from "../tools/live/credentials.mjs";
import { createLiveTransport } from "../tools/live/transport.mjs";
import { createCloudflareEdgeAdapter } from "./adapters/cloudflare.mjs";
import { createMerakiAdapter } from "./adapters/meraki.mjs";
import { createPaloAltoAdapter } from "./adapters/paloalto.mjs";
import { createApp } from "./app.mjs";
import { createCommitJournal } from "./commit-journal.mjs";
import { createAudit } from "./audit.mjs";
import { createChangeService } from "./changes.mjs";
import { liveWriteAuthorized } from "./live-authorization.mjs";
import { createOidc } from "./oidc.mjs";
import { createReadiness } from "./readiness.mjs";
import { createOperations } from "./operations.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createSessions } from "./sessions.mjs";
import { createSnapshotStore } from "./store.mjs";
import { loadTargets } from "./targets.mjs";
import { SIMULATOR_TARGETS } from "./simulator-targets.mjs";
import { createLivePolicy, createTargetResolver } from "./target-resolution.mjs";

/**
 * Live service. Everything comes from a settings file; nothing is defaulted toward live.
 * settings: { origin, dataDir, oidc, groupRoles, collector, intervalMs, retention, policy, tenantId, baselinePath, targets }
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
  const changes = createChangeService({ transport, access: { member: ({ contextId }) => contextId === "live" }, policy: settings.policy, tenantId: settings.tenantId, owner: config.twinId, baseline: () => config, audit, now, killSwitch: killSwitch.get });
  // Palo Alto and Meraki writes. Each target gets its own adapter whose HTTP client may reach only that target's host.
  // Having an adapter authorizes nothing: every operation is approved and re-checked at execution.
  const loaded = loadTargets(settings.targets ?? [], { live: true });
  if (loaded.problems.length > 0) throw new Error(`invalid targets: ${loaded.problems.join("; ")}`);
  const adapterCache = new Map();
  const adapterFor = (t) => {
    if (!adapterCache.has(t.id)) {
      const http = createGuardedHttp({ allowedHosts: [t.host], fetchImpl });
      adapterCache.set(t.id, t.vendor === "paloalto" ? createPaloAltoAdapter({ http, target: t, env }) : t.vendor === "cloudflare" ? createCloudflareEdgeAdapter({ http, target: t, env }) : createMerakiAdapter({ http, target: t, env }));
    }
    return adapterCache.get(t.id);
  };
  // Live inventory: separate from the synthetic fixtures, which it may not reuse. Access is listed per alias in settings.
  const resolver = createTargetResolver({ mode: "live", targets: loaded.targets, fixtures: SIMULATOR_TARGETS });
  const policy = createLivePolicy(Object.fromEntries([...loaded.targets.values()].map((t) => [t.id, t.access.principals])));
  // Durable commit intent and job ids, on the same persistent volume as the operations file.
  await mkdir(join(settings.dataDir, "commit-journal"), { recursive: true });
  const journal = createCommitJournal(join(settings.dataDir, "commit-journal"));
  const operations = createOperations({ resolver, policy, journal, adapterFor, audit, now, killSwitch: killSwitch.get, transportKind: "live", liveAuthorized: () => liveWriteAuthorized(settings.policy), file: join(settings.dataDir, "operations.json") });
  let n = 0;
  const scheduler = createScheduler({
    intervalMs: settings.intervalMs ?? 3_600_000, now,
    job: async () => {
      if (killSwitch.get()) return { ok: false, refusal: "kill_switch" };
      n += 1;
      const result = await collectSnapshot({ settings: settings.collector, env, fetchImpl, now: now(), snapshotId: `COLLECT-${now().toISOString().replace(/\D/g, "").slice(0, 14)}-${n}` });
      if (!result.ok) { await audit.record({ event: "collect.refused", actor: "scheduler", reason: result.refusal }); return result; }
      await store.save(result.snapshot, { savedAt: now().toISOString(), savedBy: "collector", scope: "live" });
      if (settings.retention) await store.applyRetention({ now: now(), ...settings.retention, scope: "live" });
      await audit.record({ event: "collect.saved", actor: "scheduler", snapshot: result.snapshot.snapshotId });
      return { ok: true };
    }
  });
  const sessions = createSessions({ now: () => now().getTime() });
  // The storage runner comes from deployment glue: a runner that starts two separate test tasks on the same access point and
  // reports kind "ecs-efs"). None is built here, so without one the panel says the check cannot be run.
  const readiness = createReadiness({ deploymentId: settings.deploymentId ?? createHash("sha256").update(`${settings.origin}|${settings.dataDir}`).digest("hex").slice(0, 16), storageRunner: settings.storageRunner ?? null, operations, audit, now, file: join(settings.dataDir, "readiness.json") });
  const app = createApp({ mode: "live", origin: settings.origin, secureCookies: true, sessions, oidc, groupRoles: settings.groupRoles, store, scheduler, changes, operations, readiness, audit, killSwitch });
  return { app, store, audit, scheduler, changes, operations, readiness, sessions, killSwitch };
}

export async function main(argv) {
  const liveFile = argv.find((a) => a.startsWith("--live="))?.slice(7);
  if (!liveFile) { console.error("usage: main.mjs --live=<settings file>  (the learner service is server/learner-deployed.mjs; the local persona test entry is server/learner.mjs)"); return 2; }
  const port = Number(argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3500);
  const svc = await createLiveService({ settings: JSON.parse(await readFile(liveFile, "utf8")) });
  await new Promise((resolve) => svc.app.listen(port, "127.0.0.1", resolve));
  svc.scheduler.start();
  console.log(`Control plane (live) on 127.0.0.1:${port}; put a TLS-terminating proxy in front of it`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
