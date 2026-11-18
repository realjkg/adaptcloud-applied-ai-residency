#!/usr/bin/env node
// Sequencing simulator for the twin stages. No network access.
// A stage is accepted only when every fact it requires has already been produced.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STAGES = join(HERE, "..", "stages");

const list = (value) => (!value || value === "none" ? [] : value.split(",").map((item) => item.trim()).filter(Boolean));

/** Parses the key: value front matter between two `---` lines. The body is the lesson text. */
export function parseStage(filename, text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`${filename}: missing front matter`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^(\w+):\s*(.*)$/);
    if (pair) meta[pair[1]] = pair[2].trim();
  }
  if (!meta.id || !meta.title) throw new Error(`${filename}: front matter needs id and title`);
  return {
    id: meta.id,
    title: meta.title,
    file: filename,
    requires: list(meta.requires),
    produces: list(meta.produces),
    body: text.slice(match[0].length)
  };
}

export function loadStages(dir = DEFAULT_STAGES) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseStage(name, readFileSync(join(dir, name), "utf8")));
}

function producersOf(stages) {
  const map = new Map();
  for (const stage of stages) for (const key of stage.produces) if (!map.has(key)) map.set(key, stage.id);
  return map;
}

/** Static checks: duplicate ids, duplicate producers, requirements nobody produces, and cycles. */
export function checkGraph(stages) {
  const problems = [];
  const ids = new Set();
  for (const stage of stages) {
    if (ids.has(stage.id)) problems.push(`duplicate stage id ${stage.id}`);
    ids.add(stage.id);
  }
  const producers = new Map();
  for (const stage of stages) {
    for (const key of stage.produces) {
      if (producers.has(key)) problems.push(`${key} is produced by both ${producers.get(key)} and ${stage.id}`);
      else producers.set(key, stage.id);
    }
  }
  for (const stage of stages) {
    for (const key of stage.requires) {
      if (!producers.has(key)) problems.push(`stage ${stage.id} requires ${key}, which no stage produces`);
    }
  }
  if (plan(stages).length !== stages.length && problems.length === 0) problems.push("the stage graph contains a cycle");
  return { problems };
}

/**
 * One valid order: repeatedly take the lowest-numbered stage whose requirements are already produced.
 * Several orders can be valid; this one is deterministic so every student sees the same sequence.
 * A stage that can never run (missing producer or cycle) is left out, so the result is shorter.
 */
export function plan(stages) {
  const remaining = [...stages].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const done = new Set();
  const ordered = [];
  for (;;) {
    const index = remaining.findIndex((stage) => stage.requires.every((key) => done.has(key)));
    if (index < 0) break;
    const [stage] = remaining.splice(index, 1);
    ordered.push(stage);
    for (const key of stage.produces) done.add(key);
  }
  return ordered;
}

/** Applies stages in the given order to an empty twin. A refused stage produces nothing. */
export function applySequence(stages, ids) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const state = new Set();
  const steps = [];
  for (const id of ids) {
    const stage = byId.get(id);
    if (!stage) {
      steps.push({ id, status: "unknown" });
      continue;
    }
    const missing = stage.requires.filter((key) => !state.has(key));
    if (missing.length > 0) {
      steps.push({ id, status: "refused", missing });
      continue;
    }
    const isNew = stage.produces.some((key) => !state.has(key));
    for (const key of stage.produces) state.add(key);
    steps.push({ id, status: isNew ? "applied" : "already-applied", produces: stage.produces });
  }
  const ok = steps.every((step) => step.status === "applied" || step.status === "already-applied");
  return { steps, state: [...state].sort(), ok };
}

const usage = `Usage:
  node tools/twin-sequence.mjs plan              print one valid configuration order
  node tools/twin-sequence.mjs check             validate the stage dependency graph
  node tools/twin-sequence.mjs run <id> [...]    apply stages in the order you give; refusals show what is missing
  node tools/twin-sequence.mjs verify            apply the full plan and confirm the twin is complete
  node tools/twin-sequence.mjs show <id>         print one stage's lesson`;

function printSteps(result) {
  for (const step of result.steps) {
    if (step.status === "refused") console.log(`REFUSED  ${step.id}  missing: ${step.missing.join(", ")}`);
    else if (step.status === "unknown") console.log(`UNKNOWN  ${step.id}  no such stage`);
    else console.log(`${step.status === "applied" ? "APPLIED " : "SKIPPED "} ${step.id}  produces: ${step.produces.join(", ")}`);
  }
  console.log(`\ntwin facts: ${result.state.length ? result.state.join(", ") : "(none)"}`);
}

export function main(argv, stages = loadStages()) {
  const [command, ...rest] = argv;
  if (command === "plan") {
    const ordered = plan(stages);
    const produced = new Set();
    ordered.forEach((stage, index) => {
      console.log(`${index + 1}. ${stage.id} ${stage.title}`);
      console.log(`     requires: ${stage.requires.join(", ") || "none"}`);
      for (const key of stage.produces) produced.add(key);
      console.log(`     produces: ${stage.produces.join(", ")}`);
    });
    return ordered.length === stages.length ? 0 : 1;
  }
  if (command === "check") {
    const { problems } = checkGraph(stages);
    if (problems.length === 0) console.log(`ok: ${stages.length} stages, dependency graph is consistent`);
    for (const problem of problems) console.log(`PROBLEM: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "run") {
    if (rest.length === 0) {
      console.log(usage);
      return 2;
    }
    const result = applySequence(stages, rest);
    printSteps(result);
    return result.ok ? 0 : 1;
  }
  if (command === "verify") {
    const ordered = plan(stages).map((stage) => stage.id);
    const result = applySequence(stages, ordered);
    printSteps(result);
    const complete = result.ok && ordered.length === stages.length && result.state.includes("validation.passed");
    console.log(complete ? "\nVERIFIED: the twin reaches validation.passed in the planned order." : "\nNOT VERIFIED: the twin did not reach validation.passed.");
    return complete ? 0 : 1;
  }
  if (command === "show") {
    const stage = stages.find((candidate) => candidate.id === rest[0]);
    if (!stage) {
      console.log(`no stage ${rest[0] ?? ""}`.trim());
      return 2;
    }
    console.log(`# ${stage.id} ${stage.title}\n${stage.body}`);
    return 0;
  }
  console.log(usage);
  return command === undefined || command === "help" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
