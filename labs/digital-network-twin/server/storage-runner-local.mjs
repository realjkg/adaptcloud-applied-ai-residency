// A storage check runner for simulator and learner deployments: it runs the two phases against a local directory, one
// after the other. It is labeled "local" and is never evidence about a deployed volume. A runner that starts two separate
// Fargate test tasks on the same EFS access point would report kind "ecs-efs" and implement the same run() contract; that
// runner needs AWS access and is not built here.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPhase, writePhase } from "../tools/journal-volume-check.mjs";

export function createLocalStorageRunner({ dir = null } = {}) {
  let n = 0;
  return {
    kind: "local",
    async run() {
      const base = dir ?? await mkdtemp(join(tmpdir(), "twin-storage-"));
      n += 1;
      const write = await writePhase(base);
      // One process stands in for both tasks, so the different-task check is switched off. That is why this result is labeled simulated.
      const verify = await verifyPhase(base, { requireDifferentHost: false });
      return { tasks: [{ id: `local-${n}-write`, role: "write", ok: write.ok, checks: write.checks }, { id: `local-${n}-verify`, role: "verify", ok: verify.ok, checks: verify.checks }] };
    }
  };
}

/** The learner deployments use the local simulation. It is labeled as such everywhere it is shown. */
export const createStorageRunnerForLearners = () => createLocalStorageRunner();
