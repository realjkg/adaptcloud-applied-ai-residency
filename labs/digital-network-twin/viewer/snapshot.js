// Snapshot contract for the topology viewer. Pure, with no DOM, so the browser and Node share one implementation.
//
// A snapshot is one point-in-time view of the topology: where the data came from, when the state was true, a digest
// of the topology, and the graph itself. The viewer draws a snapshot and never calls a vendor. A collector that does
// call vendor APIs (read-only, inside the customer's environment) produces snapshots in this shape.
//
// Snapshot content is untrusted input. validateSnapshot() runs before anything is drawn.

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const LIMITS = { nodes: 500, edges: 2000, groups: 50, lines: 8, text: 120 };

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const VENDOR = /^[a-z0-9][a-z0-9-]{0,29}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export const EDGE_KINDS = ["solid", "dotted", "thick", "line"];
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v, max = LIMITS.text) => typeof v === "string" && v.length >= 1 && v.length <= max;

/** JSON with sorted keys, so the same content always has the same digest. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const topologyDigest = (topology) => sha256Hex(stableStringify(topology));

/** Returns a list of problems. Messages name fields and positions, never values. */
export function validateSnapshot(s) {
  const problems = [];
  if (!isObject(s)) return ["the snapshot must be a JSON object"];
  if (s.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) problems.push(`schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`);
  if (typeof s.snapshotId !== "string" || !ID.test(s.snapshotId)) problems.push("snapshotId must be 1 to 64 letters, digits, or . _ -");
  if (typeof s.capturedAt !== "string" || !TIME.test(s.capturedAt) || Number.isNaN(Date.parse(s.capturedAt))) problems.push("capturedAt must be an ISO 8601 time with a zone");
  if (!text(s.label)) problems.push("label must be 1 to 120 characters");
  if (typeof s.synthetic !== "boolean") problems.push("synthetic must be true or false");
  if (typeof s.configDigest !== "string" || !/^[0-9a-f]{64}$/.test(s.configDigest)) problems.push("configDigest must be a SHA-256 hex digest");
  if (typeof s.topologyDigest !== "string" || !/^[0-9a-f]{64}$/.test(s.topologyDigest)) problems.push("topologyDigest must be a SHA-256 hex digest");

  const source = s.source;
  if (!isObject(source) || !text(source.kind, 40)) problems.push("source.kind must be 1 to 40 characters");
  else {
    for (const key of ["access", "plannedAccess"]) {
      const list = source[key];
      if (!Array.isArray(list) || list.length > 20) problems.push(`source.${key} must be a list of at most 20 entries`);
      else list.forEach((a, i) => {
        if (!isObject(a) || typeof a.vendor !== "string" || !VENDOR.test(a.vendor) || !text(a.level, 80) || !text(a.mode, 40)) problems.push(`source.${key}[${i}] needs vendor, level, and mode`);
      });
    }
  }

  const t = s.topology;
  if (!isObject(t) || !Array.isArray(t.nodes) || !Array.isArray(t.edges) || !Array.isArray(t.groups)) return [...problems, "topology needs nodes, edges, and groups lists"];
  if (t.nodes.length > LIMITS.nodes) problems.push(`topology.nodes may not exceed ${LIMITS.nodes}`);
  if (t.edges.length > LIMITS.edges) problems.push(`topology.edges may not exceed ${LIMITS.edges}`);
  if (t.groups.length > LIMITS.groups) problems.push(`topology.groups may not exceed ${LIMITS.groups}`);
  if (problems.length > 0 && (t.nodes.length > LIMITS.nodes || t.edges.length > LIMITS.edges)) return problems;

  const nodeIds = new Set();
  t.nodes.forEach((n, i) => {
    if (!isObject(n) || typeof n.id !== "string" || !ID.test(n.id)) return problems.push(`nodes[${i}].id is not valid`);
    if (nodeIds.has(n.id)) problems.push(`nodes[${i}].id is a duplicate`);
    nodeIds.add(n.id);
    if (!Array.isArray(n.lines) || n.lines.length < 1 || n.lines.length > LIMITS.lines || n.lines.some((l) => !text(l))) problems.push(`nodes[${i}].lines must be 1 to ${LIMITS.lines} short strings`);
    if (typeof n.vendor !== "string" || !VENDOR.test(n.vendor)) problems.push(`nodes[${i}].vendor is not valid`);
    if (n.path !== undefined && !text(n.path)) problems.push(`nodes[${i}].path is not valid`);
  });
  const edgeKeys = new Set();
  t.edges.forEach((e, i) => {
    if (!isObject(e) || typeof e.from !== "string" || typeof e.to !== "string") return problems.push(`edges[${i}] needs from and to`);
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) problems.push(`edges[${i}] refers to a node that does not exist`);
    if (!EDGE_KINDS.includes(e.kind)) problems.push(`edges[${i}].kind is not valid`);
    if (typeof e.danger !== "boolean") problems.push(`edges[${i}].danger must be true or false`);
    for (const optional of ["rule", "path"]) if (e[optional] !== undefined && !text(e[optional])) problems.push(`edges[${i}].${optional} is not valid`);
    if (!Array.isArray(e.lines) || e.lines.length > LIMITS.lines || e.lines.some((l) => !text(l))) problems.push(`edges[${i}].lines must be at most ${LIMITS.lines} short strings`);
    const key = edgeKey(e);
    if (edgeKeys.has(key)) problems.push(`edges[${i}] duplicates another edge`);
    edgeKeys.add(key);
  });
  const grouped = new Set();
  t.groups.forEach((g, i) => {
    if (!isObject(g) || typeof g.id !== "string" || !ID.test(g.id) || !text(g.title, 80) || !Array.isArray(g.nodeIds)) return problems.push(`groups[${i}] needs id, title, and nodeIds`);
    for (const id of g.nodeIds) {
      if (!nodeIds.has(id)) problems.push(`groups[${i}] refers to a node that does not exist`);
      if (grouped.has(id)) problems.push(`groups[${i}] places a node that is already in another group`);
      grouped.add(id);
    }
  });
  if (grouped.size !== nodeIds.size) problems.push("every node must belong to exactly one group");
  return problems;
}

export const edgeKey = (e) => `${e.from}>${e.to}>${(e.lines ?? []).join("/")}`;

/** What changed between two snapshots, by node id and by edge identity. Pure. */
export function diffSnapshots(before, after) {
  const nodes = (s) => new Map(s.topology.nodes.map((n) => [n.id, n]));
  const edges = (s) => new Map(s.topology.edges.map((e) => [edgeKey(e), e]));
  const [bn, an, be, ae] = [nodes(before), nodes(after), edges(before), edges(after)];
  const out = { nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } };
  for (const [id, n] of an) {
    if (!bn.has(id)) out.nodes.added.push(id);
    else if (stableStringify(bn.get(id).lines) !== stableStringify(n.lines)) out.nodes.changed.push(id);
  }
  for (const id of bn.keys()) if (!an.has(id)) out.nodes.removed.push(id);
  for (const [key, e] of ae) {
    if (!be.has(key)) out.edges.added.push(key);
    else if (be.get(key).kind !== e.kind || be.get(key).danger !== e.danger) out.edges.changed.push(key);
  }
  for (const key of be.keys()) if (!ae.has(key)) out.edges.removed.push(key);
  for (const list of [out.nodes.added, out.nodes.removed, out.nodes.changed, out.edges.added, out.edges.removed, out.edges.changed]) list.sort();
  return out;
}

export const isEmptyDiff = (d) => Object.values(d.nodes).every((l) => l.length === 0) && Object.values(d.edges).every((l) => l.length === 0);
