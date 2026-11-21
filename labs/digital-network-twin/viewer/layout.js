// Deterministic layout for the topology viewer. Pure, with no DOM.
//
// Groups are placed in columns by role: the edge and the branch on the left, the firewall in the middle with
// management under it, and the data center on the right. A group the layout does not know gets its own column to
// the right, so an unfamiliar vendor still draws. This is a column layout for this topology shape, not a general
// graph layout. A general layout engine can replace it behind the same function.

export const NODE_W = 210;
export const LINE_H = 16;
export const NODE_PAD = 12;
export const GROUP_PAD = 18;
export const TITLE_H = 28;
export const COL_GAP = 200;
export const ROW_GAP = 54;
export const BAND_GAP = 44;
export const MARGIN = 28;
const LABEL_HALF = 72;

const PLACE = { internet: { col: 0, band: 0 }, branch: { col: 0, band: 1 }, ngfw: { col: 1, band: 0 }, mgmt: { col: 1, band: 1 }, dc: { col: 2, band: 0 } };
const nodeHeight = (n) => 2 * NODE_PAD + n.lines.length * LINE_H;

/** Where a straight line between two rectangles meets each border. */
export function edgeEndpoints(a, b) {
  const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const [ca, cb] = [centre(a), centre(b)];
  const clip = (rect, from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === 0) return { ...from };
    const t = Math.min(dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx), dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy));
    return { x: from.x + dx * t, y: from.y + dy * t };
  };
  const p1 = clip(a, ca, cb);
  const p2 = clip(b, cb, ca);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2 };
}

/**
 * Geometry for a connection. Nodes in different columns, and nodes that are neighbours in a stack, get a straight line.
 * Nodes stacked in the same column with others between them get an arc beside the stack, on the right when the
 * connection runs downward and on the left when it runs upward. The bulge grows with the distance, so the line never
 * crosses a node in between and parallel arcs do not overlap.
 */
export function edgeGeometry(a, b) {
  const sameColumn = Math.abs(a.x - b.x) <= 1;
  const gap = a.y < b.y ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
  if (!sameColumn || gap <= ROW_GAP + 2) {
    const p = edgeEndpoints(a, b);
    return { kind: "line", x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, mx: p.mx, my: p.my, d: `M${p.x1},${p.y1} L${p.x2},${p.y2}` };
  }
  const down = a.y < b.y;
  const sx = down ? a.x + a.w : a.x;
  const sy = a.y + a.h / 2;
  const ey = b.y + b.h / 2;
  const reach = Math.min(130, 44 + Math.abs(ey - sy) * 0.2);
  const dir = down ? 1 : -1;
  const my = (sy + ey) / 2;
  return { kind: "arc", x1: sx, y1: sy, x2: sx, y2: ey, mx: sx + dir * reach, my, d: `M${sx},${sy} Q${sx + dir * reach * 2},${my} ${sx},${ey}` };
}

/** @returns {{ nodes: Map<string, Rect>, groups: Map<string, Rect & {title: string}>, width: number, height: number }} */
export function layout(topology, hiddenIds = new Set()) {
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const shown = topology.groups
    .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => !hiddenIds.has(id) && byId.has(id)) }))
    .filter((g) => g.nodeIds.length > 0);

  let extra = 3;
  const cells = new Map();
  for (const g of shown) {
    const place = PLACE[g.id] ?? { col: extra++, band: 0 };
    g.place = place;
    if (!cells.has(place.col)) cells.set(place.col, []);
    cells.get(place.col).push(g);
  }

  const groupW = NODE_W + 2 * GROUP_PAD;
  const nodes = new Map();
  const groups = new Map();
  let width = 0;
  let height = 0;

  for (const col of [...cells.keys()].sort((a, b) => a - b)) {
    let y = MARGIN;
    const x = MARGIN + col * (groupW + COL_GAP);
    for (const g of cells.get(col).sort((a, b) => a.place.band - b.place.band || a.id.localeCompare(b.id))) {
      const heights = g.nodeIds.map((id) => nodeHeight(byId.get(id)));
      const innerH = heights.reduce((sum, h) => sum + h, 0) + ROW_GAP * (heights.length - 1);
      const h = TITLE_H + innerH + 2 * GROUP_PAD;
      groups.set(g.id, { x, y, w: groupW, h, title: g.title });
      let ny = y + TITLE_H + GROUP_PAD;
      g.nodeIds.forEach((id, i) => {
        nodes.set(id, { x: x + GROUP_PAD, y: ny, w: NODE_W, h: heights[i] });
        ny += heights[i] + ROW_GAP;
      });
      y += h + BAND_GAP;
      height = Math.max(height, y - BAND_GAP + MARGIN);
    }
    width = Math.max(width, x + groupW + MARGIN);
  }

  // Arcs and their labels reach beyond the columns. Measure them, and widen or shift the drawing so none is clipped.
  let minX = MARGIN;
  let maxX = width - MARGIN;
  for (const e of topology.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const g = edgeGeometry(a, b);
    minX = Math.min(minX, g.x1, g.x2, g.mx - LABEL_HALF);
    maxX = Math.max(maxX, g.x1, g.x2, g.mx + LABEL_HALF);
  }
  const shift = Math.max(0, MARGIN - minX);
  if (shift > 0) {
    for (const r of nodes.values()) r.x += shift;
    for (const r of groups.values()) r.x += shift;
  }
  width = Math.max(width + shift, maxX + shift + MARGIN);
  return { nodes, groups, width: Math.max(width, 2 * MARGIN), height: Math.max(height, 2 * MARGIN) };
}
