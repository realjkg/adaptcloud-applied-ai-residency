import { test } from "node:test";
import { browserTest, playwright } from "./browser.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { buildStory } from "../tools/snapshot.mjs";
import { diffSnapshots, edgeKey, isEmptyDiff, stableStringify, topologyDigest, validateSnapshot } from "../viewer/snapshot.js";
import { edgeGeometry, layout, NODE_W } from "../viewer/layout.js";
import { snapshotToDrawio } from "../viewer/drawio.js";
import { createViewerServer } from "../viewer/serve.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(root, "snapshots", name), "utf8"));
const reference = () => load("SYNTH-SNAP-003.json");

test("committed snapshots match what the build produces", async () => {
  const files = await buildStory();
  for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(root, "snapshots", name), "utf8"), content, `${name} is stale: run npm run snapshot`);
});

test("every snapshot validates and its digest matches its topology", async () => {
  for (const name of readdirSync(join(root, "snapshots")).filter((n) => n.startsWith("SYNTH-"))) {
    const s = load(name);
    assert.deepEqual(validateSnapshot(s), []);
    assert.equal(s.topologyDigest, await topologyDigest(s.topology));
    assert.equal(s.synthetic, true);
    assert.deepEqual(s.source.access, []);
  }
});

test("the snapshot config digest equals the as-built config digest", () => {
  const config = JSON.parse(readFileSync(join(root, "config", "twin-config.json"), "utf8"));
  assert.equal(reference().configDigest, createHash("sha256").update(stableStringify(config)).digest("hex"));
});

test("validation rejects malformed and oversized snapshots without echoing values", () => {
  const bad = (mutate) => { const s = structuredClone(reference()); mutate(s); return validateSnapshot(s); };
  assert.ok(bad((s) => { s.schemaVersion = 2; }).length > 0);
  assert.ok(bad((s) => { s.topology.edges[0].to = "nope"; }).some((p) => /does not exist/.test(p)));
  assert.ok(bad((s) => { s.topology.nodes[0].lines = ["<script>alert(1)</script>".repeat(10)]; }).length > 0);
  assert.ok(bad((s) => { s.topology.nodes.push({ ...s.topology.nodes[0] }); }).some((p) => /duplicate/.test(p)));
  assert.ok(bad((s) => { s.topology.groups[0].nodeIds.pop(); }).length > 0);
  assert.ok(bad((s) => { s.capturedAt = "yesterday"; }).length > 0);
  assert.ok(bad((s) => { s.topology.nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, lines: ["x"], vendor: "f5" })); }).length > 0);
  assert.deepEqual(validateSnapshot(null), ["the snapshot must be a JSON object"]);
  const problems = bad((s) => { s.label = 42; s.topology.nodes[1].id = "bad id<script>"; });
  assert.ok(!problems.join(" ").includes("<script>"));
});

test("the diff between the reference build and the proposed change is one added connection", () => {
  const d = diffSnapshots(load("SYNTH-SNAP-003.json"), load("SYNTH-SNAP-004.json"));
  assert.equal(d.edges.added.length, 1);
  assert.match(d.edges.added[0], /^z_vpn_branch>z_app>/);
  assert.deepEqual([d.nodes.added, d.nodes.removed, d.nodes.changed, d.edges.removed, d.edges.changed], [[], [], [], [], []]);
  assert.ok(isEmptyDiff(diffSnapshots(reference(), reference())));
});

test("layout places every node once, inside its group, without overlap, and arcs stay on the canvas", () => {
  for (const name of ["SYNTH-SNAP-001.json", "SYNTH-SNAP-003.json", "SYNTH-SNAP-004.json"]) {
    const s = load(name);
    const lay = layout(s.topology);
    assert.equal(lay.nodes.size, s.topology.nodes.length);
    const rects = [...lay.nodes.values()];
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, "nodes overlap")));
    for (const g of s.topology.groups) for (const id of g.nodeIds) {
      const n = lay.nodes.get(id);
      const box = lay.groups.get(g.id);
      assert.ok(n.x >= box.x && n.x + n.w <= box.x + box.w && n.y >= box.y && n.y + n.h <= box.y + box.h);
    }
    for (const e of s.topology.edges) {
      const p = edgeGeometry(lay.nodes.get(e.from), lay.nodes.get(e.to));
      for (const x of [p.x1, p.x2, p.mx]) assert.ok(x >= 0 && x <= lay.width, "edge leaves the canvas");
    }
  }
  assert.equal(NODE_W, 210);
});

test("layout hides nodes and is stable for the same input", () => {
  const s = reference();
  const hidden = new Set(s.topology.nodes.filter((n) => n.vendor === "f5").map((n) => n.id));
  assert.equal(layout(s.topology, hidden).nodes.size, s.topology.nodes.length - hidden.size);
  assert.equal(JSON.stringify([...layout(s.topology).nodes]), JSON.stringify([...layout(s.topology).nodes]));
});

test("the draw.io export is well-formed, keeps every element and connection, and escapes snapshot text", () => {
  const s = structuredClone(load("SYNTH-SNAP-004.json"));
  s.topology.nodes[0].lines = ['A "quoted" <b>&</b>', "second line"];
  const xml = snapshotToDrawio(s);
  assert.equal((xml.match(/kind="node"/g) ?? []).length, s.topology.nodes.length);
  assert.equal((xml.match(/kind="connection"/g) ?? []).length, s.topology.edges.length);
  assert.equal((xml.match(/kind="group"/g) ?? []).length, s.topology.groups.length);
  assert.match(xml, /A &quot;quoted&quot; &lt;b&gt;&amp;&lt;\/b&gt;&#10;second line/);
  assert.ok(!xml.includes("<b>"));
  assert.match(xml, /danger="true"/);
  assert.match(xml, /strokeColor=#c62828/);
  const ids = [...xml.matchAll(/ id="(c_[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicate cell ids");
  for (const [, ref] of xml.matchAll(/(?:source|target)="([^"]+)"/g)) assert.ok(ids.includes(ref), `dangling reference ${ref}`);
});

test("the viewer server is read-only, local, and limited to its own files", async () => {
  const server = createViewerServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`${base}/snapshots/SYNTH-SNAP-003.json`)).status, 200);
    for (const asset of ["app.js", "operate.js", "sdwan.js", "scenario.js", "viewer.css"]) assert.equal((await fetch(`${base}/${asset}`)).status, 200, asset);
    for (const path of ["/constructor", "/__proto__", "/toString", "/hasOwnProperty", "/snapshots/__proto__.json", "/snapshots/..%2Fconfig%2Ftwin-config.json", "/snapshots/%2e%2e/package.json", "/package.json", "/../package.json", "/snapshots/x.txt", "/serve.mjs"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(`${base}/`, { method })).status, 405);
    assert.equal(server.address().address, "127.0.0.1");
  } finally { server.close(); }
});

test("viewer sources avoid markup sinks, network calls to other hosts, and inline code", () => {
  const forbidden = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /localStorage|sessionStorage/, /XMLHttpRequest|WebSocket|sendBeacon/, /https?:\/\//];
  for (const name of ["app.js", "operate.js", "sdwan.js", "scenario.js", "render.js", "layout.js", "snapshot.js", "drawio.js"]) {
    const src = readFileSync(join(root, "viewer", name), "utf8").replace(/\/\/.*$/gm, "").replace(/"http:\/\/www\.w3\.org\/2000\/svg"/g, "");
    for (const re of forbidden) assert.ok(!re.test(src), `${name} matches ${re}`);
  }
  const html = readFileSync(join(root, "viewer", "index.html"), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "inline script");
  assert.ok(!/\sstyle=|\son\w+=/i.test(html), "inline style or handler");
  assert.match(html, /script-src 'self'/);
});


browserTest("in a browser: draws, verifies, diffs, captures SVG and PNG, and rejects a hostile file", async () => {
  const server = createViewerServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const problems = [];
    page.on("pageerror", (e) => problems.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("svg [data-node]");
    assert.match(await page.locator("#integrity").textContent(), /Digest verified/);

    await page.locator("#snapshot-select").selectOption("SYNTH-SNAP-004.json");
    await page.locator("#compare-select").selectOption("SYNTH-SNAP-003.json");
    await page.waitForSelector("[data-diff]");
    assert.match(await page.locator("#diff-summary").textContent(), /1 connection added/);

    const [svgDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#capture-svg").click()]);
    assert.match(svgDownload.suggestedFilename(), /^SYNTH-SNAP-004-.*\.svg$/);
    const svgText = readFileSync(await svgDownload.path(), "utf8");
    assert.match(svgText, /<metadata[^>]*>.*SYNTH-SNAP-004/s);
    assert.match(svgText, /Point-in-time view of SYNTH-SNAP-004/);
    assert.ok(!/<script/i.test(svgText));

    const [pngDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#capture-png").click()]);
    assert.match(pngDownload.suggestedFilename(), /\.png$/);
    assert.equal(readFileSync(await pngDownload.path()).subarray(1, 4).toString(), "PNG");

    const [drawioDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#capture-drawio").click()]);
    assert.match(drawioDownload.suggestedFilename(), /\.drawio$/);
    assert.match(readFileSync(await drawioDownload.path(), "utf8"), /<mxfile/);

    const hostile = structuredClone(reference());
    hostile.topology.nodes[0].lines = ["<img src=x onerror=window.__pwned=1>"];
    await page.locator("input[type=file]").first().setInputFiles({ name: "hostile.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(hostile)) });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(await page.locator("img").count(), 0);
    assert.deepEqual(problems.filter((p) => !/Failed to load resource/.test(p)), []);
  } finally { await browser.close(); server.close(); }
});
