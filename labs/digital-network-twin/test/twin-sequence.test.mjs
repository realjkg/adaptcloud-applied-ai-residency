import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applySequence, checkGraph, DEFAULT_STAGES, loadStages, parseStage, plan } from "../tools/twin-sequence.mjs";

const stages = loadStages();
const position = (ordered, id) => ordered.findIndex((stage) => stage.id === id);

test("parseStage reads front matter and keeps the lesson body", () => {
  const stage = parseStage("x.md", "---\nid: 90\ntitle: Example\nrequires: none\nproduces: a.b, c.d\n---\nBody text\n");
  assert.equal(stage.id, "90");
  assert.deepEqual(stage.requires, []);
  assert.deepEqual(stage.produces, ["a.b", "c.d"]);
  assert.equal(stage.body, "Body text\n");
});

test("parseStage rejects a file without front matter or without an id", () => {
  assert.throws(() => parseStage("x.md", "no front matter"), /missing front matter/);
  assert.throws(() => parseStage("x.md", "---\ntitle: Only a title\n---\n"), /needs id and title/);
});

test("the shipped lab has twelve stages with a consistent dependency graph", () => {
  assert.equal(stages.length, 12);
  assert.deepEqual(checkGraph(stages).problems, []);
});

test("every stage file name matches its declared id", () => {
  const files = readdirSync(DEFAULT_STAGES).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(files.map((name) => name.slice(0, 2)), stages.map((stage) => stage.id));
});

test("every stage teaches its verification and its out-of-order failure", () => {
  for (const stage of stages) {
    assert.match(stage.body, /^## Why /m, `${stage.id} needs a rationale`);
    assert.match(stage.body, /^## Verify$/m, `${stage.id} needs a verify section`);
    assert.match(stage.body, /^## If you do it out of order$/m, `${stage.id} needs an out-of-order section`);
  }
});

test("the planned order respects every dependency and ends with validation", () => {
  const ordered = plan(stages);
  assert.equal(ordered.length, stages.length);
  assert.ok(position(ordered, "02") < position(ordered, "03"), "management is locked before zones are built");
  assert.ok(position(ordered, "03") < position(ordered, "10"), "the tunnel needs NGFW interfaces");
  assert.ok(position(ordered, "06") < position(ordered, "07"), "policy names the VIP, so the VIP comes first");
  assert.ok(position(ordered, "07") < position(ordered, "08"), "the proxy is enabled only after the edge is allowed");
  assert.ok(position(ordered, "10") < position(ordered, "11"), "branch policy needs the tunnel");
  assert.ok(position(ordered, "07") < position(ordered, "11"), "branch policy needs the NGFW rule");
  assert.equal(ordered.at(-1).id, "12");
});

test("the planned order reaches validation.passed with every stage accepted", () => {
  const result = applySequence(stages, plan(stages).map((stage) => stage.id));
  assert.equal(result.ok, true);
  assert.ok(result.state.includes("validation.passed"));
});

test("applying the virtual server before its pool is refused, and names the missing fact", () => {
  const result = applySequence(stages, ["01", "03", "05", "06"]);
  const step = result.steps.find((candidate) => candidate.id === "06");
  assert.equal(step.status, "refused");
  assert.ok(step.missing.includes("f5.pool"));
  assert.ok(step.missing.includes("pa.interfaces"), "the NGFW interfaces were skipped too");
  assert.equal(result.ok, false);
  assert.ok(!result.state.includes("f5.vip"));
});

test("policy written before the virtual server is refused", () => {
  const result = applySequence(stages, ["01", "02", "03", "07"]);
  assert.equal(result.steps.at(-1).status, "refused");
  assert.ok(result.steps.at(-1).missing.includes("f5.vip"));
});

test("a refused stage produces no facts, so later stages cascade into refusal", () => {
  const result = applySequence(stages, ["08", "09", "12"]);
  assert.deepEqual(result.steps.map((step) => step.status), ["refused", "refused", "refused"]);
  assert.deepEqual(result.state, []);
});

test("unknown and repeated stages are reported, not silently accepted", () => {
  const unknown = applySequence(stages, ["99"]);
  assert.equal(unknown.steps[0].status, "unknown");
  assert.equal(unknown.ok, false);
  const repeated = applySequence(stages, ["01", "01"]);
  assert.equal(repeated.steps[1].status, "already-applied");
  assert.equal(repeated.ok, true);
});

test("checkGraph reports duplicate producers, unmet requirements, duplicate ids, and cycles", () => {
  const stage = (id, requires, produces) => ({ id, title: id, file: `${id}.md`, requires, produces, body: "" });
  assert.match(checkGraph([stage("1", [], ["a"]), stage("2", [], ["a"])]).problems.join("\n"), /produced by both/);
  assert.match(checkGraph([stage("1", ["missing"], ["a"])]).problems.join("\n"), /requires missing, which no stage produces/);
  assert.match(checkGraph([stage("1", [], ["a"]), stage("1", [], ["b"])]).problems.join("\n"), /duplicate stage id 1/);
  assert.match(checkGraph([stage("1", ["b"], ["a"]), stage("2", ["a"], ["b"])]).problems.join("\n"), /cycle/);
});

test("every stage file parses without a front-matter error", () => {
  for (const name of readdirSync(DEFAULT_STAGES)) {
    assert.doesNotThrow(() => parseStage(name, readFileSync(join(DEFAULT_STAGES, name), "utf8")));
  }
});
