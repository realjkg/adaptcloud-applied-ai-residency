// Health-monitor decision rules. Pure: no clock, no randomness, no network, no knowledge of where observations come from.
//
// A monitor sends a request to a pool member and expects something back. A member is healthy when it answers and the answer
// contains what the monitor expects. A pool is available when every member is healthy, degraded when some are, and offline
// when none are. How a member answers is an observation supplied by the caller (a fixture, here); the rules below only decide
// what an observation means.

const PATH = /^\/[A-Za-z0-9._~/-]{0,63}$/;
const EXPECT = /^[A-Za-z0-9 ._-]{1,40}$/;

/** Validates the structured monitor a browser may submit. Returns a list of problems. */
export function validateMonitor(m) {
  const bad = [];
  if (m === null || typeof m !== "object" || Array.isArray(m)) return ["monitor must be an object"];
  if (typeof m.path !== "string" || !PATH.test(m.path)) bad.push("path must start with / and use letters, digits, . _ ~ / -");
  if (typeof m.receive !== "string" || !EXPECT.test(m.receive)) bad.push("receive must be 1 to 40 letters, digits, spaces, . _ -");
  return bad;
}

/** The request line a BIG-IP style monitor would send, built from validated parts only. */
export const sendString = (m, host) => `GET ${m.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;

/**
 * One probe. `answer` is what the member returned for the monitor's path: null when it did not answer at all, otherwise
 * { status, body }.
 */
export function judge(monitor, answer) {
  if (answer === null || answer === undefined) return { path: monitor.path, answered: false, status: null, matched: false, healthy: false, reason: "no_response" };
  const text = `${answer.status} ${answer.body}`;
  const matched = text.includes(monitor.receive);
  const ok = Number.isInteger(answer.status) && answer.status >= 200 && answer.status < 400;
  return { path: monitor.path, answered: true, status: answer.status, matched, healthy: ok && matched, reason: !ok ? "unsuccessful_status" : matched ? "expected_response" : "expected_text_missing" };
}

/** Pool availability from member results. */
export function poolState(results) {
  const healthy = results.filter((r) => r.probe.healthy).length;
  return { healthy, total: results.length, state: results.length > 0 && healthy === results.length ? "available" : healthy === 0 ? "offline" : "degraded" };
}

/**
 * Evaluates a monitor against members. `answerFor(member, path)` supplies the observation. Members are reported in the order
 * given, with the evidence for each, so a person can see why.
 */
export function evaluatePool(monitor, members, answerFor) {
  const results = members.map((m) => ({ id: m.id, address: m.address, port: m.port, probe: judge(monitor, answerFor(m, monitor.path)) }));
  return { monitor: { path: monitor.path, receive: monitor.receive }, members: results, ...poolState(results) };
}

/** What changes for each member between two evaluations of the same pool. */
export function compare(before, after) {
  return after.members.map((m, i) => ({ id: m.id, before: before.members[i].probe.healthy ? "healthy" : "unhealthy", after: m.probe.healthy ? "healthy" : "unhealthy", reason: m.probe.reason, status: m.probe.status, changed: before.members[i].probe.healthy !== m.probe.healthy }));
}
