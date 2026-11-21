// Deterministic backend fixtures for the maintenance scenario. Static data only: no clock, no randomness, no timers, no
// sockets, and no network probes. A member's answers are a fixed table keyed by request path, so the same monitor always
// produces the same observation.
//
// The story: the pool has two members. app-1 runs the new build, which serves /healthz and /health. app-2 still runs the
// old build, which serves /health only. Changing the monitor to /healthz therefore looks harmless and takes app-2 out of the
// pool, which is exactly the surprise a preview exists to show.

import { createHash } from "node:crypto";

export const FIXTURES = Object.freeze({
  version: 1,
  host: "app.lab.example",
  knownGood: Object.freeze({ path: "/health", receive: "200" }),
  members: Object.freeze([
    Object.freeze({ id: "app-1", address: "10.30.0.11", port: 8080, build: "2026.11", endpoints: Object.freeze({ "/health": Object.freeze({ status: 200, body: "ok" }), "/healthz": Object.freeze({ status: 200, body: "ok" }), "/ready": Object.freeze({ status: 200, body: "ready" }), "/": Object.freeze({ status: 200, body: "welcome" }) }) }),
    Object.freeze({ id: "app-2", address: "10.30.0.12", port: 8080, build: "2025.06", endpoints: Object.freeze({ "/health": Object.freeze({ status: 200, body: "ok" }), "/ready": Object.freeze({ status: 503, body: "warming" }), "/": Object.freeze({ status: 200, body: "welcome" }) }) })
  ])
});

/** What a member returns for a path: its table entry, 404 for a path it does not serve, or nothing if it is down. */
export function answerFor(member, path) {
  if (member.down === true) return null;
  return member.endpoints[path] ?? { status: 404, body: "not found" };
}

export const fixturesDigest = (fixtures = FIXTURES) => createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");
