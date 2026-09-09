import { describe, expect, it } from "vitest";
import {
  buildGraph,
  buildReport,
  parseArgs,
  resolveSpecifier,
  specifiersIn,
  type GateOptions,
  type GateReport,
  type ImportGraph
} from "../scripts/run-regression-gate.js";

const options = (overrides: Partial<GateOptions>): GateOptions => ({
  files: null,
  base: "origin/main",
  dryRun: true,
  json: false,
  all: false,
  ...overrides
});

const report = (files: string[]): GateReport => buildReport(options({ files }));
const names = (result: GateReport): string[] => result.selected.map((entry) => entry.test);
const reasonsFor = (result: GateReport, test: string): string[] => result.selected.find((entry) => entry.test === test)?.reasons ?? [];

describe("argument parsing", () => {
  it("accepts the overrides that make the gate testable", () => {
    const parsed = parseArgs(["--files=a.ts, b.ts", "--base=main", "--dry-run", "--json"]);
    expect(parsed.files).toEqual(["a.ts", "b.ts"]);
    expect(parsed.base).toBe("main");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.all).toBe(false);
  });

  it("defaults to the branch diff against origin/main", () => {
    const parsed = parseArgs([]);
    expect(parsed.files).toBeNull();
    expect(parsed.base).toBe("origin/main");
  });
});

describe("specifier resolution under NodeNext", () => {
  it("reads static import, export-from, type-only, side-effect, and JSON-attribute specifiers", () => {
    const source = [
      'import "./side-effect.js";',
      'import type { A } from "./types.js";',
      'export { b } from "./b.js";',
      'import data from "../examples/x.json" with { type: "json" };',
      'import { c } from "@scope/pkg";'
    ].join("\n");
    expect(specifiersIn(source)).toEqual(["./side-effect.js", "./types.js", "./b.js", "../examples/x.json", "@scope/pkg"]);
  });

  it("maps an emitted .js specifier onto the .ts file on disk", () => {
    expect(resolveSpecifier("src/agent/workflow.ts", "./cost.js")).toBe("src/agent/cost.ts");
    expect(resolveSpecifier("src/agent/workflow.ts", "../platform/runtime.js")).toBe("src/platform/runtime.ts");
  });

  it("keeps specifiers that already name a real file, and reports ones that do not", () => {
    expect(resolveSpecifier("tests/promotion.test.ts", "../examples/promotion-evidence.simulated.json")).toBe("examples/promotion-evidence.simulated.json");
    expect(resolveSpecifier("tests/infrastructure-guard.test.ts", "../scripts/guard-infrastructure.mjs")).toBe("scripts/guard-infrastructure.mjs");
    expect(resolveSpecifier("tests/promotion.test.ts", "../src/agent/does-not-exist.js")).toBeNull();
  });

  it("builds the repository graph with every relative specifier resolved", () => {
    const graph = buildGraph();
    expect(graph.unresolved).toEqual([]);
    expect(graph.imports.get("src/agent/workflow.ts")).toContain("src/agent/cost.ts");
    expect(graph.importers.get("src/agent/cost.ts")).toContain("src/agent/workflow.ts");
  });
});

describe("reverse dependency selection", () => {
  it("selects the transitive dependants of a leaf module, not just its own test", () => {
    const result = report(["src/agent/cost.ts"]);
    expect(result.mode).toBe("selective");
    expect(result.fallbackReason).toBeNull();
    expect(names(result)).toEqual(expect.arrayContaining(["tests/cost.test.ts", "tests/workflow.test.ts", "tests/claude.test.ts", "tests/agent-tools.test.ts"]));
    // workflow.ts imports cost.ts, and the workflow suite imports workflow.ts — two hops.
    expect(result.closure).toContain("src/agent/workflow.ts");
    expect(reasonsFor(result, "tests/workflow.test.ts")).toEqual(["depends on changed module src/agent/cost.ts"]);
    expect(result.skipped).toContain("tests/telemetry.test.ts");
    expect(names(result)).not.toContain("tests/telemetry.test.ts");
  });

  it("pulls a wide closure from a platform module many suites depend on", () => {
    const result = report(["src/platform/runtime.ts"]);
    expect(names(result)).toEqual(expect.arrayContaining(["tests/runtime.test.ts", "tests/claude.test.ts", "tests/agent-tools.test.ts", "tests/promotion.test.ts"]));
    expect(result.closure.length).toBeGreaterThan(report(["src/agent/cost.ts"]).closure.length);
    expect(reasonsFor(result, "tests/promotion.test.ts")).toContain("depends on changed module src/platform/runtime.ts");
  });

  it("selects a test that is itself changed and says so", () => {
    const changed = ["tests", "telemetry.test.ts"].join("/");
    const result = report([changed]);
    expect(names(result)).toContain(changed);
    expect(reasonsFor(result, changed)).toEqual(["changed on this branch"]);
    expect(names(result)).not.toContain("tests/cost.test.ts");
  });

  it("follows a JSON fixture through the import graph", () => {
    const result = report(["examples/labs/commercial.json"]);
    expect(names(result)).toEqual(expect.arrayContaining(["tests/lab-simulations.test.ts", "tests/scenarios.test.ts"]));
    expect(reasonsFor(result, "tests/scenarios.test.ts")).toEqual(["depends on changed module examples/labs/commercial.json"]);
    expect(result.skipped).toContain("tests/telemetry.test.ts");
  });

  it("selects the suite that runs a module through its dist build output", () => {
    const result = report(["src/server.ts"]);
    expect(names(result)).toContain("tests/server-routes.test.ts");
    expect(reasonsFor(result, "tests/server-routes.test.ts")).toContain("executes built artifact of src/server.ts");
  });
});

describe("non-module dependencies", () => {
  it("selects the suites that read a workflow rather than import it", () => {
    const result = report([".github/workflows/infrastructure.yml"]);
    expect(names(result)).toEqual(expect.arrayContaining(["tests/infrastructure.test.ts", "tests/promotion-workflow.test.ts", "tests/cleanup.test.ts"]));
    expect(reasonsFor(result, "tests/infrastructure.test.ts")).toEqual(["reads changed file .github/workflows/infrastructure.yml"]);
  });

  it("selects the cleanup suite for the shell script it shells out to", () => {
    const result = report(["scripts/verify-sandbox-cleanup.sh"]);
    expect(names(result)).toContain("tests/cleanup.test.ts");
    expect(reasonsFor(result, "tests/cleanup.test.ts")).toEqual(["reads changed file scripts/verify-sandbox-cleanup.sh"]);
  });

  it("selects the deployment suite for a config file it asserts on", () => {
    const result = report(["vercel.json"]);
    expect(names(result)).toContain("tests/vercel.test.ts");
    expect(reasonsFor(result, "tests/vercel.test.ts")).toEqual(["reads changed file vercel.json"]);
  });

  it("selects the handoff suite for a workflow it reads", () => {
    const result = report([".github/workflows/student-handoff.yml"]);
    expect(names(result)).toContain("tests/student-handoff.test.ts");
  });

  it("selects the skills suite for a skill script it never imports, naming the directory it matched", () => {
    const result = report([".claude/skills/residency-gates/scripts/run-gates.mjs"]);
    expect(names(result)).toContain("tests/skills.test.ts");
    expect(reasonsFor(result, "tests/skills.test.ts")).toEqual([
      "reads .claude/skills/, which contains changed file .claude/skills/residency-gates/scripts/run-gates.mjs"
    ]);
  });

  it("selects nothing for a document no suite reads", () => {
    // Built rather than written literally: a path spelled out here would appear in this file's
    // own source and the mention fallback would, correctly, select this very suite.
    const result = report([["docs", "UNRELATED_NOTE.md"].join("/")]);
    expect(result.mode).toBe("selective");
    expect(result.selected).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(15);
  });
});

describe("failing safe", () => {
  const everySuite = (result: GateReport): void => {
    expect(result.mode).toBe("full");
    expect(result.skipped).toEqual([]);
    expect(names(result)).toContain("tests/telemetry.test.ts");
    expect(names(result)).toContain("tests/cost.test.ts");
  };

  it("runs the whole suite when the change set is empty", () => {
    const result = report([]);
    everySuite(result);
    expect(result.fallbackReason).toBe("--files= was empty; an empty change set cannot be proven safe");
    expect(reasonsFor(result, "tests/cost.test.ts")).toEqual(["full suite: --files= was empty; an empty change set cannot be proven safe"]);
  });

  it("runs the whole suite when a specifier cannot be resolved", () => {
    const broken: ImportGraph = {
      imports: new Map(),
      importers: new Map(),
      executes: new Map(),
      text: new Map(),
      unresolved: [{ importer: "src/agent/workflow.ts", specifier: "./ghost.js" }]
    };
    const result = buildReport(options({ files: ["src/agent/cost.ts"] }), () => broken);
    everySuite(result);
    expect(result.fallbackReason).toBe("unresolved import ./ghost.js in src/agent/workflow.ts (1 total); the graph is incomplete");
  });

  it("runs the whole suite when the graph cannot be built at all", () => {
    const result = buildReport(options({ files: ["src/agent/cost.ts"] }), () => {
      throw new Error("disk gone");
    });
    everySuite(result);
    expect(result.fallbackReason).toBe("import graph could not be built: disk gone");
  });

  it("runs the whole suite when --all is requested", () => {
    const result = buildReport(options({ all: true, files: ["src/agent/cost.ts"] }));
    everySuite(result);
    expect(result.fallbackReason).toBe("--all requested");
  });
});
