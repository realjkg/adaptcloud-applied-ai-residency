// Draws a snapshot as SVG. Every string from a snapshot is set with textContent or setAttribute, never as markup,
// so a hostile snapshot cannot inject script or elements. The SVG sets its own colors with attributes and no CSS,
// so an exported copy is self-contained and looks the same wherever it is opened.

import { edgeGeometry, layout, LINE_H, NODE_PAD } from "./layout.js";
import { edgeKey } from "./snapshot.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
const FOOTER_H = 64;

// Fill and stroke per vendor. Color is never the only signal: a finding is also dashed and labeled.
const PALETTE = {
  internet: { fill: "#f1f3f5", stroke: "#5b6670" },
  cloudflare: { fill: "#fff1e3", stroke: "#b45309" },
  paloalto: { fill: "#e6f4ea", stroke: "#1e7a3c" },
  f5: { fill: "#e7eefc", stroke: "#2b57b8" },
  meraki: { fill: "#f3e8fb", stroke: "#7a3aa8" },
  unknown: { fill: "#f1f3f5", stroke: "#5b6670" }
};
export const paletteFor = (vendor) => PALETTE[vendor] ?? PALETTE.unknown;
const FINDING = "#c62828";
const INK = "#1b1f23";

const el = (doc, name, attrs = {}, text) => {
  const node = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The word-width of a line at the sizes used here. Approximate, and enough to size a label background. */
const textWidth = (s, size) => Math.ceil(s.length * size * 0.56);

/**
 * @param {Document} doc
 * @param {object} snapshot a validated snapshot
 * @param {object} [options]
 * @param {Set<string>} [options.hiddenVendors] vendors to leave out
 * @param {boolean} [options.findingsOnly] show only findings and the nodes they touch
 * @param {string} [options.query] dim nodes that do not match this text
 * @param {string} [options.selectedId]
 * @param {object} [options.diff] result of diffSnapshots(before, after), drawn on the after snapshot
 * @param {string} [options.renderedAt] ISO time to print in the footer
 */
export function renderTopology(doc, snapshot, options = {}) {
  const { hiddenVendors = new Set(), findingsOnly = false, query = "", selectedId = null, diff = null, renderedAt = "" } = options;
  const topo = snapshot.topology;
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));

  let visible = topo.edges.filter((e) => !hiddenVendors.has(byId.get(e.from).vendor) && !hiddenVendors.has(byId.get(e.to).vendor));
  let hiddenIds = new Set(topo.nodes.filter((n) => hiddenVendors.has(n.vendor)).map((n) => n.id));
  if (findingsOnly) {
    visible = visible.filter((e) => e.danger);
    const keep = new Set(visible.flatMap((e) => [e.from, e.to]));
    hiddenIds = new Set(topo.nodes.filter((n) => !keep.has(n.id)).map((n) => n.id));
  }

  const lay = layout(topo, hiddenIds);
  const width = Math.max(lay.width, 520);
  const height = lay.height + FOOTER_H;
  const needle = query.trim().toLowerCase();
  const matches = (n) => needle === "" || n.lines.join(" ").toLowerCase().includes(needle) || (n.path ?? "").toLowerCase().includes(needle);

  const svg = el(doc, "svg", { xmlns: SVG_NS, viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-labelledby": "topo-title topo-desc", "font-family": "system-ui, sans-serif" });
  svg.append(el(doc, "title", { id: "topo-title" }, `${snapshot.label}, as of ${snapshot.capturedAt}`));
  svg.append(el(doc, "desc", { id: "topo-desc" }, `Topology snapshot ${snapshot.snapshotId} with ${topo.nodes.length} elements and ${topo.edges.length} connections. ${snapshot.synthetic ? "Synthetic data." : ""}`));
  // The capture facts travel inside the file, so an exported view says when it was true and what it was made from.
  svg.append(el(doc, "metadata", { id: "topo-capture" }, JSON.stringify({
    schemaVersion: snapshot.schemaVersion, snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, label: snapshot.label, synthetic: snapshot.synthetic,
    configDigest: snapshot.configDigest, topologyDigest: snapshot.topologyDigest, sourceKind: snapshot.source.kind, renderedAt
  })));
  const defs = el(doc, "defs");
  for (const [id, color] of [["arrow", "#3d464d"], ["arrow-finding", FINDING]]) {
    const marker = el(doc, "marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" });
    marker.append(el(doc, "path", { d: "M0,0 L10,5 L0,10 z", fill: color }));
    defs.append(marker);
  }
  svg.append(defs);
  svg.append(el(doc, "rect", { x: 0, y: 0, width, height, fill: "#ffffff" }));

  for (const [id, g] of lay.groups) {
    const box = el(doc, "g", { "data-group": id });
    box.append(el(doc, "rect", { x: g.x, y: g.y, width: g.w, height: g.h, rx: 10, fill: "#fafbfc", stroke: "#c9d1d9" }));
    box.append(el(doc, "text", { x: g.x + 14, y: g.y + 19, "font-size": 13, "font-weight": 600, fill: "#3d464d" }, g.title));
    svg.append(box);
  }

  const diffEdges = new Set([...(diff?.edges.added ?? []), ...(diff?.edges.changed ?? [])]);
  for (const e of visible) {
    const a = lay.nodes.get(e.from);
    const b = lay.nodes.get(e.to);
    if (!a || !b) continue;
    const p = edgeGeometry(a, b);
    const color = e.danger ? FINDING : "#3d464d";
    const added = diffEdges.has(edgeKey(e));
    const g = el(doc, "g", { "data-edge": edgeKey(e), "data-danger": e.danger ? "true" : "false", ...(added ? { "data-diff": "added" } : {}) });
    const dash = e.danger ? "7 4" : e.kind === "dotted" ? "2 5" : undefined;
    g.append(el(doc, "path", { d: p.d, fill: "none", stroke: added && !e.danger ? "#1e7a3c" : color, "stroke-width": e.kind === "thick" ? 4 : e.danger || added ? 3 : 1.6, "stroke-dasharray": dash, "marker-end": e.kind === "line" ? undefined : `url(#${e.danger ? "arrow-finding" : "arrow"})` }));
    const labelLines = [...(e.danger ? ["FINDING"] : []), ...(e.lines ?? [])];
    if (labelLines.length > 0) {
      const w = Math.max(...labelLines.map((l) => textWidth(l, 11))) + 10;
      const h = labelLines.length * 13 + 6;
      g.append(el(doc, "rect", { x: p.mx - w / 2, y: p.my - h / 2, width: w, height: h, rx: 4, fill: "#ffffff", "fill-opacity": 0.92, stroke: e.danger ? FINDING : "#d0d7de" }));
      labelLines.forEach((line, i) => g.append(el(doc, "text", { x: p.mx, y: p.my - h / 2 + 15 + i * 13, "text-anchor": "middle", "font-size": 11, "font-weight": i === 0 && e.danger ? 700 : 400, fill: e.danger ? FINDING : INK }, line)));
    }
    svg.append(g);
  }

  const nodeEls = new Map();
  for (const [id, r] of lay.nodes) {
    const n = byId.get(id);
    const c = paletteFor(n.vendor);
    const dim = !matches(n);
    const state = diff?.nodes.added.includes(id) ? "added" : diff?.nodes.changed.includes(id) ? "changed" : null;
    const g = el(doc, "g", { "data-node": id, "data-vendor": n.vendor, tabindex: 0, role: "button", cursor: "pointer", "aria-label": n.lines.join(", "), opacity: dim ? 0.3 : 1, ...(state ? { "data-diff": state } : {}) });
    g.append(el(doc, "rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, fill: c.fill, stroke: id === selectedId ? "#0b5cff" : state ? "#1e7a3c" : c.stroke, "stroke-width": id === selectedId || state ? 3 : 1.5 }));
    n.lines.forEach((line, i) => g.append(el(doc, "text", { x: r.x + NODE_PAD, y: r.y + NODE_PAD + 12 + i * LINE_H, "font-size": 12, "font-weight": i === 0 ? 700 : 400, fill: INK }, line)));
    svg.append(g);
    nodeEls.set(id, g);
  }

  const footerY = lay.height + 12;
  const facts = [
    `Point-in-time view of ${snapshot.snapshotId}: ${snapshot.label}`,
    `State as of ${snapshot.capturedAt}. Digest ${snapshot.topologyDigest.slice(0, 16)}. Source: ${snapshot.source.kind}.${snapshot.synthetic ? " Synthetic data." : ""}`,
    renderedAt ? `Rendered in the browser at ${renderedAt}.` : ""
  ].filter(Boolean);
  svg.append(el(doc, "line", { x1: 28, y1: footerY - 4, x2: width - 28, y2: footerY - 4, stroke: "#d0d7de" }));
  facts.forEach((line, i) => svg.append(el(doc, "text", { x: 28, y: footerY + 12 + i * 15, "font-size": 11, fill: "#3d464d" }, line)));
  return { svg, nodeEls, width, height };
}

export function serializeSvg(svg) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}\n`;
}
