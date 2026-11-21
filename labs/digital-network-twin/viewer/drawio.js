// Exports a snapshot as a diagrams.net (draw.io) file. Pure, with no DOM, so the browser and Node share it.
//
// The file is uncompressed mxGraph XML. Every element is a real, editable shape that carries its vendor, config path,
// and snapshot facts as data, so the diagram can be restyled in draw.io, imported by Lucidchart, or exported to Visio
// (.vsdx) from draw.io. It uses draw.io's built-in shapes only. Vendor icon stencils are a styling step to add and
// confirm in the tool, not something this file claims to carry.

import { layout } from "./layout.js";

const COLORS = {
  internet: ["#f1f3f5", "#5b6670"], cloudflare: ["#fff1e3", "#b45309"], paloalto: ["#e6f4ea", "#1e7a3c"],
  f5: ["#e7eefc", "#2b57b8"], meraki: ["#f3e8fb", "#7a3aa8"], unknown: ["#f1f3f5", "#5b6670"]
};
// Built-in draw.io shapes that read as the role of the element.
const SHAPE = { internet: "shape=cloud", f5: "rounded=1", paloalto: "rounded=1", meraki: "rounded=1", cloudflare: "shape=cloud", unknown: "rounded=1" };

const esc = (s) => String(s).replace(/[&<>"'\n\r\t]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\n": "&#10;", "\r": "&#13;", "\t": "&#9;" })[c]);
const cell = (id) => `c_${String(id).replace(/[^A-Za-z0-9_]/g, "_")}`;

export function snapshotToDrawio(snapshot) {
  const topo = snapshot.topology;
  const lay = layout(topo);
  const meta = { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, topologyDigest: snapshot.topologyDigest, synthetic: String(snapshot.synthetic) };
  const out = [];
  const obj = (id, label, attrs, inner) => out.push(`<object label="${esc(label)}" id="${id}" ${Object.entries({ ...meta, ...attrs }).map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}>${inner}</object>`);

  for (const g of topo.groups) {
    const r = lay.groups.get(g.id);
    if (!r) continue;
    obj(cell(`group_${g.id}`), g.title, { kind: "group" }, `<mxCell style="rounded=1;whiteSpace=wrap;html=0;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;fillColor=#fafbfc;strokeColor=#c9d1d9;container=0;" vertex="1" parent="1"><mxGeometry x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" as="geometry"/></mxCell>`);
  }
  for (const n of topo.nodes) {
    const r = lay.nodes.get(n.id);
    const [fill, stroke] = COLORS[n.vendor] ?? COLORS.unknown;
    obj(cell(n.id), n.lines.join("\n"), { kind: "node", vendor: n.vendor, ...(n.path ? { configPath: n.path } : {}) }, `<mxCell style="${SHAPE[n.vendor] ?? SHAPE.unknown};whiteSpace=wrap;html=0;align=left;spacingLeft=8;fillColor=${fill};strokeColor=${stroke};" vertex="1" parent="1"><mxGeometry x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" as="geometry"/></mxCell>`);
  }
  topo.edges.forEach((e, i) => {
    const color = e.danger ? "#c62828" : "#3d464d";
    const dash = e.danger ? "dashed=1;dashPattern=7 4;" : e.kind === "dotted" ? "dashed=1;dashPattern=2 5;" : "";
    const width = e.kind === "thick" ? 4 : e.danger ? 3 : 1.6;
    const label = [...(e.danger ? ["FINDING"] : []), ...(e.lines ?? [])].join("\n");
    obj(cell(`edge_${i}`), label, { kind: "connection", danger: String(e.danger), ...(e.rule ? { rule: e.rule } : {}), ...(e.path ? { configPath: e.path } : {}) },
      `<mxCell style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;endArrow=${e.kind === "line" ? "none" : "block"};strokeColor=${color};strokeWidth=${width};fontColor=${color};labelBackgroundColor=#ffffff;${dash}" edge="1" parent="1" source="${cell(e.from)}" target="${cell(e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="topology-viewer" version="1"><diagram id="${cell(snapshot.snapshotId)}" name="${esc(snapshot.snapshotId)}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" page="0" pageWidth="${Math.ceil(lay.width)}" pageHeight="${Math.ceil(lay.height)}" math="0" shadow="0" background="#ffffff"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${out.join("")}</root></mxGraphModel></diagram></mxfile>\n`;
}
