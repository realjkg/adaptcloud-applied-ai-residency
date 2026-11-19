// DEPLOYED learner service: the container entry point for learner-facing tasks.
//
// OpenID Connect is required and so is enrollment: after sign-in the server resolves which lab the identity belongs to, and an
// identity that is in no lab gets no session. There is no persona sign-in anywhere in this module's import graph and the app
// is started in "learner" mode, where the persona route does not exist. Simulated vendors only: no vendor credentials, no live
// adapters, no collectors. The OIDC client is a public client (PKCE); it carries no client secret, so nothing here reads the
// process environment.
//
// Startup fails, with no listener, unless the settings are complete.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.mjs";
import { createEnrollment } from "./enrollment.mjs";
import { createLearnerCore } from "./learner-core.mjs";
import { createOidc } from "./oidc.mjs";

export class DeploymentError extends Error { constructor(code) { super(code); this.name = "DeploymentError"; this.code = code; } }

/**
 * settings: { origin, dataDir, deploymentId?, oidc: { issuer, authorizationEndpoint, tokenEndpoint, jwksUri, clientId, groupsClaim? },
 *             groupRoles: { <group>: <role> }, labs: { <labId>: { members: [<subject>], aliases: [<alias>] } } }
 */
export async function createLearnerDeployed({ settings, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const need = (cond, code) => { if (!cond) throw new DeploymentError(code); };
  need(settings && typeof settings === "object", "settings_missing");
  need(String(settings.origin ?? "").startsWith("https://"), "https_origin_required");
  need(settings.oidc && typeof settings.oidc === "object", "oidc_required");
  need(!("clientSecret" in settings.oidc) && !("clientSecretEnv" in settings.oidc), "learner_oidc_is_a_public_client");
  need(typeof settings.dataDir === "string" && settings.dataDir.length > 0, "data_dir_required");
  need(settings.groupRoles && Object.keys(settings.groupRoles).length > 0, "group_roles_required");
  need(settings.labs && Object.keys(settings.labs).length > 0, "labs_required");
  need(!("personas" in settings), "personas_not_allowed");
  for (const [id, lab] of Object.entries(settings.labs)) need(Array.isArray(lab.members) && lab.members.length > 0 && Array.isArray(lab.aliases), `lab_${id}_incomplete`);
  const enrollment = createEnrollment(settings.labs);
  let oidc;
  try { oidc = createOidc({ config: { ...settings.oidc, redirectUri: `${settings.origin}/auth/callback` }, fetchImpl }); } catch { throw new DeploymentError("oidc_invalid"); }

  const core = await createLearnerCore({ dir: settings.dataDir, labs: settings.labs, now, deploymentId: settings.deploymentId ?? "learner-deployed" });
  const app = createApp({ mode: "learner", origin: settings.origin, secureCookies: true, sessions: core.sessions, oidc, enrollment, groupRoles: settings.groupRoles, store: core.store, schedulerFor: core.schedulerFor, changes: core.changes, operations: core.operations, readiness: core.readiness, audit: core.audit, auditFilter: core.auditFilter, killSwitch: core.killSwitch });
  return { app, ...core, enrollment };
}

export async function main(argv) {
  const file = argv.find((a) => a.startsWith("--settings="))?.slice(11);
  const port = Number(argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3500);
  if (!file) { console.error("startup refused: --settings=<file> is required"); return 2; }
  let svc;
  try { svc = await createLearnerDeployed({ settings: JSON.parse(await readFile(file, "utf8")) }); } catch (error) { console.error(`startup refused: ${error.code ?? "settings_unreadable"}`); return 1; }
  // Bind all interfaces only inside a container behind the platform's own network controls and a TLS-terminating front end.
  await new Promise((resolve) => svc.app.listen(port, argv.includes("--all-interfaces") ? "0.0.0.0" : "127.0.0.1", resolve));
  console.log(`Learner service (OIDC, enrollment) on port ${port}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
