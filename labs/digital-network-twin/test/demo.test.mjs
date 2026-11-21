import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemoChecks } from "../tools/demo-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runbook = readFileSync(join(root, "docs", "WORKING_SESSION.md"), "utf8");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

test("every demo step behaves as the runbook says", async () => {
  const results = await runDemoChecks();
  assert.ok(results.length >= 11);
  for (const r of results) assert.ok(r.ok, `${r.step}: ${r.detail}`);
});

test("every npm script named in the runbook exists", () => {
  const named = [...runbook.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]);
  assert.ok(named.length >= 6);
  for (const name of new Set(named)) assert.ok(scripts[name], `npm run ${name} is not a script`);
});

test("every file the runbook points at exists", () => {
  // Scan the whole document, code blocks included, for paths with a known extension.
  const paths = [...runbook.matchAll(/(?:docs|config|demo|rendered|scenarios|tools)\/[A-Za-z0-9_.\/-]+\.(?:md|json|mjs)/g)].map((m) => m[0]);
  const unique = new Set(paths);
  assert.ok(unique.size >= 7, `only ${unique.size} distinct paths found`);
  for (const path of unique) assert.ok(existsSync(join(root, path)), `${path} does not exist`);
  for (const name of ["partial-1-ngfw", "partial-2-ngfw-and-f5", "proposed-change-safe", "proposed-change-risky"]) assert.ok(unique.has(`demo/${name}.json`), `the runbook never uses demo/${name}.json`);
});

test("the claims table says what is not built, and names the vendor gap", () => {
  assert.match(runbook, /kept in sync with production \| \*\*Not built\.\*\*/);
  assert.match(runbook, /Cisco platforms other than Meraki are not modeled/);
  assert.match(runbook, /Palo Alto and Meraki adapters are not built/);
  assert.match(runbook, /SD-WAN is not modeled/);
  assert.match(runbook, /No agent that ingests/);
  for (const topic of ["Changes validated", "Docs that stay current", "Works across vendors", "Agents can help"]) assert.ok(runbook.includes(topic), topic);
});

test("the runbook keeps the agenda's five sections and their times", () => {
  for (const row of ["| 5 | Intros", "| 15 | Their network picture", "| 20 | What a twin looks like", "| 15 | What it would look like here", "| 5 | Next steps and owners"]) assert.ok(runbook.includes(row), row);
});

test("the demo fixtures are synthetic and contain no credential-like fields", () => {
  const files = readdirSync(join(root, "demo")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 4);
  for (const file of files) {
    const text = readFileSync(join(root, "demo", file), "utf8");
    assert.match(JSON.parse(text).twinId, /^SYNTH-/, file);
    assert.ok(!/password|secret|token|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY/i.test(text.replace(/secret-store:\/\//g, "")), file);
  }
});
