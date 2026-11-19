// LOCAL TEST ENTRY for the learner service: persona sign-in, in-memory, bound to 127.0.0.1 unless told otherwise.
//
// This is NOT the deployed learner service. The deployed image runs server/learner-deployed.mjs, which requires OpenID
// Connect and enrollment and contains no persona sign-in. Nothing the deployed entry imports reaches this file, and
// test/learner-isolation.test.mjs enforces that.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.mjs";
import { createLearnerCore } from "./learner-core.mjs";

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

/** Builds the local test service on a directory. Used by tests and by `npm run control:learner:local`. */
export async function createSimulatorService({ dir, origin, now = () => new Date() }) {
  const core = await createLearnerCore({ dir, labs: LABS, now });
  const app = createApp({ mode: "simulator", origin, sessions: core.sessions, personas: PERSONAS, store: core.store, schedulerFor: core.schedulerFor, changes: core.changes, operations: core.operations, readiness: core.readiness, audit: core.audit, auditFilter: core.auditFilter, killSwitch: core.killSwitch });
  return { app, ...core, scheduler: core.schedulerFor({ labId: "lab-a", subject: "persona:operator" }), transport: core.transportFor("lab-a") };
}

export async function main(argv) {
  const port = Number(argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3500);
  const dir = await mkdtemp(join(tmpdir(), "twin-control-"));
  const origin = argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? `http://127.0.0.1:${port}`;
  const { app } = await createSimulatorService({ dir, origin });
  await new Promise((resolve) => app.listen(port, "127.0.0.1", resolve));
  console.log(`Learner service, LOCAL TEST entry (persona sign-in), on ${origin}/  data in ${dir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
