#!/usr/bin/env node
// Select and run only the tests that intersect this branch's changes.
//
// Running the whole suite on every change is safe but slow; running only the changed file's own
// test is fast and wrong, because a change reaches every module that imports it transitively.
// This walks the import graph backwards from the changed files, then adds the tests that reach a
// changed file by reading it rather than importing it. Anything it cannot prove, it widens: an
// unresolvable specifier or an ambiguous change runs the whole suite and says why.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const scanRoots = ["src", "scripts", "tests"];
const scanExtensions = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];

export interface Selection { test: string; reasons: string[] }

export interface GateReport {
  schemaVersion: "1.0";
  mode: "selective" | "full";
  fallbackReason: string | null;
  changedFiles: string[];
  closure: string[];
  selected: Selection[];
  skipped: string[];
}

export interface GateOptions {
  files: string[] | null;
  base: string;
  dryRun: boolean;
  json: boolean;
  all: boolean;
}

export function parseArgs(argv: readonly string[]): GateOptions {
  const filesArg = argv.find((arg) => arg.startsWith("--files="));
  const baseArg = argv.find((arg) => arg.startsWith("--base="));
  return {
    files: filesArg === undefined ? null : filesArg.slice("--files=".length).split(",").map((file) => file.trim()).filter(Boolean),
    base: baseArg === undefined ? "origin/main" : baseArg.slice("--base=".length),
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
    all: argv.includes("--all")
  };
}

function git(args: string[]): { status: number | null; stdout: string } {
  const run = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "" };
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Committed changes against the base plus anything dirty in the working tree. */
export function detectChangedFiles(base: string): { files: string[]; dirty: boolean; error: string | null } {
  // -uall expands untracked directories into individual files; a bare directory entry would
  // otherwise be matched as a path that no test can mention.
  const status = git(["status", "--porcelain", "-uall"]);
  if (status.status !== 0) return { files: [], dirty: false, error: "git status failed; the change set cannot be trusted" };
  // Porcelain v1 columns are two status characters plus a space; renames read "old -> new".
  const working = status.stdout.split("\n").filter((line) => line.length > 3).map((line) => line.slice(3).trim()).map((path) => path.split(" -> ").at(-1) ?? path).filter(Boolean);
  const diff = git(["diff", "--name-only", `${base}...HEAD`]);
  if (diff.status !== 0) return { files: [...new Set(working)].sort(), dirty: working.length > 0, error: `git diff against ${base} failed; only the working tree is visible` };
  return { files: [...new Set([...working, ...lines(diff.stdout)])].sort(), dirty: working.length > 0, error: null };
}

function walk(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (scanExtensions.some((extension) => entry.name.endsWith(extension))) out.push(relative(repoRoot, full));
  }
}

export function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of scanRoots) {
    const full = join(repoRoot, root);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full, found);
  }
  return found.sort();
}

const specifierPattern = /(?:from|import)\s*["']([^"']+)["']/;

/**
 * Line-scoped on purpose: a specifier only counts when its line opens an import/export statement
 * or closes a multi-line binding list. Matching anywhere would pick up specifiers quoted inside
 * string literals — this file's own tests contain some — and poison the graph with phantom edges.
 */
export function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!/^(import\b|export\b|\})/.test(trimmed)) continue;
    const match = specifierPattern.exec(trimmed);
    if (match?.[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/**
 * NodeNext ESM writes relative specifiers with the emitted extension, so `./foo.js` names `foo.ts`
 * on disk. JSON and `.mjs` specifiers already name a real file, so try the literal path first.
 */
export function resolveSpecifier(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(repoRoot, dirname(importer), specifier);
  const rewrites: string[] = [base];
  const swap: ReadonlyArray<readonly [string, string]> = [[".js", ".ts"], [".mjs", ".mts"], [".cjs", ".cts"], [".jsx", ".tsx"]];
  for (const [from, to] of swap) if (base.endsWith(from)) rewrites.push(`${base.slice(0, -from.length)}${to}`);
  for (const extension of scanExtensions) rewrites.push(`${base}${extension}`, join(base, `index${extension}`));
  for (const candidate of rewrites) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(repoRoot, candidate);
  }
  return null;
}

export interface ImportGraph {
  /** module -> modules it imports */ imports: Map<string, string[]>;
  /** module -> modules that import it (including built-artifact edges) */ importers: Map<string, string[]>;
  /** module -> source modules it runs through their `dist/` build output */ executes: Map<string, string[]>;
  text: Map<string, string>;
  unresolved: Array<{ importer: string; specifier: string }>;
}

const distPattern = /dist\/((?:[\w.-]+\/)*[\w.-]+)\.(?:js|mjs|cjs)/g;

/** A suite that spawns a built artifact under dist/ depends on the source module behind it. */
function executedSources(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(distPattern)) {
    const stem = match[1] ?? "";
    for (const extension of [".ts", ".mts", ".mjs"]) {
      const candidate = `${stem}${extension}`;
      if (existsSync(join(repoRoot, candidate))) {
        found.add(candidate);
        break;
      }
    }
  }
  return [...found];
}

export function buildGraph(): ImportGraph {
  const imports = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  const executes = new Map<string, string[]>();
  const text = new Map<string, string>();
  const unresolved: Array<{ importer: string; specifier: string }> = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    text.set(file, source);
    const targets: string[] = [];
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveSpecifier(file, specifier);
      if (target === null) {
        unresolved.push({ importer: file, specifier });
        continue;
      }
      targets.push(target);
      importers.set(target, [...(importers.get(target) ?? []), file]);
    }
    const run = executedSources(source).filter((target) => target !== file);
    if (run.length > 0) {
      executes.set(file, run);
      for (const target of run) importers.set(target, [...(importers.get(target) ?? []), file]);
    }
    imports.set(file, targets);
  }
  return { imports, importers, executes, text, unresolved };
}

const isTest = (file: string): boolean => file.startsWith("tests/") && file.endsWith(".test.ts");

/** Every module that reaches a changed module through one or more import edges, plus the roots. */
export function reverseClosure(graph: ImportGraph, changed: readonly string[]): Map<string, string> {
  const origin = new Map<string, string>();
  const queue: string[] = [];
  for (const file of changed) {
    if (origin.has(file)) continue;
    origin.set(file, file);
    queue.push(file);
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const root = origin.get(current) as string;
    for (const importer of graph.importers.get(current) ?? []) {
      if (origin.has(importer)) continue;
      origin.set(importer, root);
      queue.push(importer);
    }
  }
  return origin;
}

/**
 * Several suites here assert on files they read rather than import — workflows, terraform, config
 * profiles, skill scripts. A pure import graph would call those tests unaffected, so match the
 * changed path (and, for non-module files, its containing directories) against each test's source.
 */
function mentionReason(graph: ImportGraph, test: string, changed: string): string | null {
  const source = graph.text.get(test) ?? "";
  if (source.includes(changed)) return `reads changed file ${changed}`;
  if (graph.imports.has(changed)) return null;
  const segments = changed.split("/");
  for (let depth = segments.length - 1; depth >= 2; depth -= 1) {
    const prefix = segments.slice(0, depth).join("/");
    if (source.includes(prefix)) return `reads ${prefix}/, which contains changed file ${changed}`;
  }
  return null;
}

export function selectTests(changed: readonly string[], graph: ImportGraph): { closure: string[]; selected: Selection[]; skipped: string[] } {
  const origin = reverseClosure(graph, changed);
  const tests = sourceFiles().filter(isTest);
  const reasons = new Map<string, string[]>();
  const add = (test: string, reason: string): void => {
    const existing = reasons.get(test) ?? [];
    if (!existing.includes(reason)) reasons.set(test, [...existing, reason]);
  };
  for (const test of tests) {
    if (changed.includes(test)) add(test, "changed on this branch");
    const root = origin.get(test);
    if (root !== undefined && root !== test) add(test, `depends on changed module ${root}`);
    for (const target of graph.executes.get(test) ?? []) {
      if (origin.has(target)) add(test, `executes built artifact of ${target}`);
    }
    for (const file of changed) {
      if (file === test) continue;
      if (origin.get(test) === file) continue;
      const reason = mentionReason(graph, test, file);
      if (reason !== null) add(test, reason);
    }
  }
  const selected = [...reasons.entries()].map(([test, why]) => ({ test, reasons: why })).sort((a, b) => a.test.localeCompare(b.test));
  return {
    closure: [...origin.keys()].sort(),
    selected,
    skipped: tests.filter((test) => !reasons.has(test))
  };
}

export function buildReport(options: GateOptions, loadGraph: () => ImportGraph = buildGraph): GateReport {
  const full = (reason: string, changedFiles: string[]): GateReport => ({
    schemaVersion: "1.0",
    mode: "full",
    fallbackReason: reason,
    changedFiles,
    closure: [],
    selected: sourceFiles().filter(isTest).map((test) => ({ test, reasons: [`full suite: ${reason}`] })),
    skipped: []
  });

  if (options.all) return full("--all requested", options.files ?? []);

  let changed: string[];
  if (options.files === null) {
    const detected = detectChangedFiles(options.base);
    if (detected.error !== null) return full(detected.error, detected.files);
    if (detected.files.length === 0 && detected.dirty) return full("working tree is dirty but no changed files were resolved", []);
    if (detected.files.length === 0) return full("no changed files detected against the base ref", []);
    changed = detected.files;
  } else {
    if (options.files.length === 0) return full("--files= was empty; an empty change set cannot be proven safe", []);
    changed = [...options.files].sort();
  }

  let graph: ImportGraph;
  try {
    graph = loadGraph();
  } catch (error) {
    return full(`import graph could not be built: ${error instanceof Error ? error.message : String(error)}`, changed);
  }
  if (graph.unresolved.length > 0) {
    const first = graph.unresolved[0] as { importer: string; specifier: string };
    return full(`unresolved import ${first.specifier} in ${first.importer} (${graph.unresolved.length} total); the graph is incomplete`, changed);
  }

  const { closure, selected, skipped } = selectTests(changed, graph);
  return { schemaVersion: "1.0", mode: "selective", fallbackReason: null, changedFiles: changed, closure, selected, skipped };
}

function render(report: GateReport): string {
  const out: string[] = [];
  out.push(`mode=${report.mode}${report.fallbackReason === null ? "" : ` (${report.fallbackReason})`}`);
  out.push(`changed files (${report.changedFiles.length}):`);
  for (const file of report.changedFiles) out.push(`  ${file}`);
  out.push(`reverse-dependency closure (${report.closure.length}):`);
  for (const file of report.closure) out.push(`  ${file}`);
  out.push(`selected tests (${report.selected.length}):`);
  for (const entry of report.selected) {
    const shown = entry.reasons.slice(0, 3).join("; ");
    const rest = entry.reasons.length - 3;
    out.push(`  ${entry.test} — ${shown}${rest > 0 ? ` (+${rest} more; use --json for all)` : ""}`);
  }
  out.push(`skipped tests (${report.skipped.length}):`);
  for (const file of report.skipped) out.push(`  ${file}`);
  return out.join("\n");
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const report = buildReport(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  if (options.dryRun) return 0;
  if (report.selected.length === 0) {
    process.stdout.write("no test intersects the change set; nothing to run\n");
    return 0;
  }
  const argvForVitest = report.mode === "full" ? ["vitest", "run"] : ["vitest", "run", ...report.selected.map((entry) => entry.test)];
  const run = spawnSync("npx", argvForVitest, { cwd: repoRoot, stdio: "inherit" });
  return run.status ?? 1;
}

// Only act as a CLI when executed directly; the tests import the selection logic.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
