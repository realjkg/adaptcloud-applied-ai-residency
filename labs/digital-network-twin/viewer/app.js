// Browser controller for the topology viewer. It reads snapshots, validates them, and draws them. It never calls a
// vendor, holds no credential, and has no write action. Every string from a snapshot reaches the page through
// textContent, so a hostile snapshot cannot add markup.

import { paletteFor, renderTopology, serializeSvg } from "./render.js";
import { diffSnapshots, isEmptyDiff, topologyDigest, validateSnapshot } from "./snapshot.js";

const $ = (id) => document.getElementById(id);
const state = { snapshot: null, rawText: "", baseline: null, hidden: new Set(), findingsOnly: false, query: "", selected: null, zoom: 1, autoFit: true, index: [], integrity: null, svg: null };

/** Small DOM builder. Text goes in as text. */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function say(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  if (isError) status.setAttribute("data-state", "error");
  else status.removeAttribute("data-state");
}

const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, "-");

async function fetchSnapshot(file) {
  const response = await fetch(`snapshots/${encodeURIComponent(file)}`, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error("the snapshot could not be loaded");
  const rawText = await response.text();
  return { rawText, value: JSON.parse(rawText) };
}

/** Validates, verifies the digest, and makes the snapshot current. Returns false, and draws nothing, if it is invalid. */
async function adopt(value, rawText) {
  const problems = validateSnapshot(value);
  if (problems.length > 0) {
    state.snapshot = null;
    $("canvas").replaceChildren(h("p", { class: "note" }, "This snapshot is not valid and was not drawn."));
    $("detail").replaceChildren(h("p", { class: "note" }, "Select an element to see where it came from."));
    say(`The snapshot is not valid: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}.`, true);
    setIntegrity(null);
    return false;
  }
  state.snapshot = value;
  state.rawText = rawText;
  state.selected = null;
  state.autoFit = true;
  state.hidden = new Set();
  state.integrity = (await topologyDigest(value.topology)) === value.topologyDigest;
  setIntegrity(state.integrity);
  $("synthetic-badge").hidden = !value.synthetic;
  buildVendorToggles();
  buildSources();
  buildLegend();
  return true;
}

function setIntegrity(ok) {
  const badge = $("integrity");
  if (ok === null) {
    badge.textContent = "";
    badge.removeAttribute("data-state");
    return;
  }
  badge.textContent = ok ? "Digest verified" : "Digest does not match";
  badge.setAttribute("data-state", ok ? "ok" : "bad");
}

function vendorsOf(snapshot) {
  return [...new Set(snapshot.topology.nodes.map((n) => n.vendor))].sort();
}

function buildVendorToggles() {
  const box = $("vendor-toggles");
  box.replaceChildren(h("legend", {}, "Vendors"));
  for (const vendor of vendorsOf(state.snapshot)) {
    const input = h("input", { type: "checkbox", checked: "", "data-vendor-toggle": vendor });
    input.addEventListener("change", () => {
      if (input.checked) state.hidden.delete(vendor);
      else state.hidden.add(vendor);
      draw();
    });
    box.append(h("label", { class: "check" }, input, h("span", { class: "swatch", "data-vendor": vendor }), vendor));
  }
}

function buildLegend() {
  const legend = $("legend");
  legend.replaceChildren();
  for (const vendor of vendorsOf(state.snapshot)) legend.append(h("li", {}, h("span", { class: "swatch", "data-vendor": vendor }), vendor));
  legend.append(h("li", {}, h("span", { class: "swatch", "data-kind": "finding" }), "Finding: an allow rule that should not exist"));
}

function buildSources() {
  const box = $("sources");
  const s = state.snapshot.source;
  const parts = [h("p", { class: "note" }, s.access.length === 0 ? `Source: ${s.kind}. No live API was called for this view.` : `Source: ${s.kind}.`)];
  if (s.access.length > 0) {
    parts.push(h("table", {}, h("tr", {}, h("th", {}, "Vendor"), h("th", {}, "Access used")), ...s.access.map((a) => h("tr", {}, h("td", {}, a.vendor), h("td", {}, `${a.level} (${a.mode})`)))));
  }
  if (s.plannedAccess.length > 0) {
    parts.push(h("p", { class: "note" }, "Access a live collector would use. Not configured."));
    parts.push(h("table", {}, h("tr", {}, h("th", {}, "Vendor"), h("th", {}, "Level")), ...s.plannedAccess.map((a) => h("tr", {}, h("td", {}, a.vendor), h("td", {}, `${a.level} (${a.mode})`)))));
  }
  box.replaceChildren(...parts);
}

function describeSelected() {
  const detail = $("detail");
  if (!state.snapshot || !state.selected) {
    detail.replaceChildren(h("p", { class: "note" }, "Select an element to see where it came from."));
    return;
  }
  const topo = state.snapshot.topology;
  const node = topo.nodes.find((n) => n.id === state.selected);
  const touching = topo.edges.filter((e) => e.from === node.id || e.to === node.id);
  const list = h("dl", {}, h("dt", {}, "Element"), h("dd", {}, node.lines.join(" · ")), h("dt", {}, "Vendor"), h("dd", {}, node.vendor), h("dt", {}, "Config path"), h("dd", {}, node.path ?? "not recorded"));
  const ul = h("ul", {});
  for (const e of touching) ul.append(h("li", {}, `${e.from === node.id ? "to" : "from"} ${e.from === node.id ? e.to : e.from}${e.rule ? `, rule ${e.rule}` : ""}${e.path ? `, ${e.path}` : ""}${e.danger ? ", FINDING" : ""}`));
  detail.replaceChildren(list, h("p", { class: "note" }, "Connections"), touching.length ? ul : h("p", { class: "note" }, "None shown."));
}

function summarizeDiff(diff) {
  const box = $("diff-summary");
  if (!diff) {
    box.textContent = "";
    return;
  }
  if (isEmptyDiff(diff)) {
    box.textContent = "No difference from the earlier view.";
    return;
  }
  const n = (list) => list.length;
  box.textContent = `Since the earlier view: ${n(diff.nodes.added)} element added, ${n(diff.nodes.removed)} removed, ${n(diff.nodes.changed)} changed; ${n(diff.edges.added)} connection added, ${n(diff.edges.removed)} removed, ${n(diff.edges.changed)} changed. Additions are outlined in green.`;
}

function draw() {
  if (!state.snapshot) return;
  const diff = state.baseline ? diffSnapshots(state.baseline, state.snapshot) : null;
  summarizeDiff(diff);
  const { svg, nodeEls, width, height } = renderTopology(document, state.snapshot, {
    hiddenVendors: state.hidden, findingsOnly: state.findingsOnly, query: state.query, selectedId: state.selected, diff, renderedAt: new Date().toISOString()
  });
  // Fit the drawing to the window unless the person has zoomed by hand. Never enlarge past 100%.
  if (state.autoFit) state.zoom = Math.max(0.3, Math.min(1, ($("canvas").clientWidth - 24) / width));
  svg.setAttribute("width", String(Math.round(width * state.zoom)));
  svg.setAttribute("height", String(Math.round(height * state.zoom)));
  for (const [id, g] of nodeEls) {
    const select = () => {
      state.selected = state.selected === id ? null : id;
      draw();
      describeSelected();
      document.querySelector(`[data-node="${CSS.escape(id)}"]`)?.focus();
    };
    g.addEventListener("click", select);
    g.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  }
  state.svg = svg;
  $("canvas").replaceChildren(svg);
  $("zoom-reset").textContent = state.autoFit ? `Fit ${Math.round(state.zoom * 100)}%` : `${Math.round(state.zoom * 100)}%`;
  const shown = nodeEls.size;
  say(`${state.snapshot.label}. Showing ${shown} of ${state.snapshot.topology.nodes.length} elements.${state.findingsOnly ? " Findings only." : ""}`);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function captureName(ext) {
  return `${safeName(state.snapshot.snapshotId)}-${safeName(state.snapshot.capturedAt)}.${ext}`;
}

/** Re-renders the current view with a fresh render time, so the capture matches what is on screen. */
function captureSvgText() {
  const diff = state.baseline ? diffSnapshots(state.baseline, state.snapshot) : null;
  const { svg } = renderTopology(document, state.snapshot, { hiddenVendors: state.hidden, findingsOnly: state.findingsOnly, query: state.query, selectedId: null, diff, renderedAt: new Date().toISOString() });
  return serializeSvg(svg);
}

function captureSvg() {
  if (!state.snapshot) return say("Nothing to capture yet.", true);
  download(new Blob([captureSvgText()], { type: "image/svg+xml" }), captureName("svg"));
  say(`Captured ${captureName("svg")}.`);
}

function capturePng() {
  if (!state.snapshot) return say("Nothing to capture yet.", true);
  const text = captureSvgText();
  const match = text.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const [w, h2] = match ? [Number(match[1]), Number(match[2])] : [1200, 800];
  const image = new Image();
  image.addEventListener("load", () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * 2);
    canvas.height = Math.round(h2 * 2);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return say("The PNG could not be created.", true);
      download(blob, captureName("png"));
      say(`Captured ${captureName("png")}.`);
    }, "image/png");
  });
  image.addEventListener("error", () => say("The PNG could not be created.", true));
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

function saveJson() {
  if (!state.snapshot) return say("Nothing to save yet.", true);
  download(new Blob([state.rawText], { type: "application/json" }), captureName("json"));
  say(`Saved ${captureName("json")}, exactly as loaded.`);
}

async function chooseBaseline(file) {
  if (!file) {
    state.baseline = null;
    return draw();
  }
  try {
    const { value } = await fetchSnapshot(file);
    const problems = validateSnapshot(value);
    if (problems.length > 0) {
      state.baseline = null;
      return say("The earlier view is not valid and was not used.", true);
    }
    state.baseline = value;
    draw();
  } catch {
    state.baseline = null;
    say("The earlier view could not be loaded.", true);
  }
}

async function chooseSnapshot(file) {
  try {
    const { value, rawText } = await fetchSnapshot(file);
    state.baseline = null;
    $("compare-select").value = "";
    if (await adopt(value, rawText)) draw();
  } catch {
    say("The snapshot could not be loaded.", true);
  }
}

function fillSelectors() {
  const snap = $("snapshot-select");
  const cmp = $("compare-select");
  snap.replaceChildren();
  cmp.replaceChildren(h("option", { value: "" }, "No comparison"));
  for (const entry of state.index) {
    const label = `${entry.capturedAt.slice(0, 10)}  ${entry.label}`;
    snap.append(h("option", { value: entry.file }, label));
    cmp.append(h("option", { value: entry.file }, label));
  }
}

async function start() {
  $("snapshot-select").addEventListener("change", (e) => chooseSnapshot(e.target.value));
  $("compare-select").addEventListener("change", (e) => chooseBaseline(e.target.value));
  $("findings-only").addEventListener("change", (e) => { state.findingsOnly = e.target.checked; draw(); });
  $("search").addEventListener("input", (e) => { state.query = e.target.value; draw(); });
  const zoom = (factor) => {
    state.autoFit = factor === 0;
    if (factor !== 0) state.zoom = Math.min(3, Math.max(0.3, state.zoom * factor));
    draw();
  };
  window.addEventListener("resize", () => { if (state.autoFit) draw(); });
  $("zoom-in").addEventListener("click", () => zoom(1.2));
  $("zoom-out").addEventListener("click", () => zoom(1 / 1.2));
  $("zoom-reset").addEventListener("click", () => zoom(0));
  $("capture-svg").addEventListener("click", captureSvg);
  $("capture-png").addEventListener("click", capturePng);
  $("save-json").addEventListener("click", saveJson);
  $("load-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rawText = await file.text();
      state.baseline = null;
      if (await adopt(JSON.parse(rawText), rawText)) draw();
    } catch {
      say("That file is not valid JSON.", true);
    }
  });

  try {
    const response = await fetch("snapshots/index.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("no index");
    const index = await response.json();
    state.index = Array.isArray(index.snapshots) ? index.snapshots.filter((s) => s && typeof s.file === "string" && /^[A-Za-z0-9._-]+\.json$/.test(s.file) && typeof s.label === "string" && typeof s.capturedAt === "string").sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)) : [];
  } catch {
    state.index = [];
  }
  fillSelectors();
  if (state.index.length === 0) return say("No snapshot list was found. Open a snapshot file to begin.");
  const latestReference = state.index.find((s) => s.id === "SYNTH-SNAP-003") ?? state.index.at(-1);
  $("snapshot-select").value = latestReference.file;
  await chooseSnapshot(latestReference.file);
}

start();
