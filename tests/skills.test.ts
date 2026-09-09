import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const skillsRoot = ".claude/skills";
const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const read = (path: string): string => readFileSync(path, "utf8");

interface Skill {
  name: string;
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

function loadSkill(name: string): Skill {
  const raw = read(join(skillsRoot, name, "SKILL.md"));
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${name}: SKILL.md must open with YAML frontmatter`);
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1 || /^\s/.test(line)) continue;
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { name, frontmatter, body: match[2] ?? "", raw };
}

const skills = skillNames.map(loadSkill);

describe("residency skill definitions", () => {
  it("ships the six CCA-F domain skills the residency depends on", () => {
    expect(skillNames).toEqual([
      "cca-f-architecture-review",
      "promotion-evidence",
      "residency-gates",
      "scenario-policy",
      "tokenomics-estimate",
      "well-architected-review"
    ]);
  });

  it("declares a name matching its directory and a description that says when to trigger", () => {
    for (const skill of skills) {
      expect(skill.frontmatter.name).toBe(skill.name);
      const description = skill.frontmatter.description ?? "";
      expect(description.length).toBeGreaterThan(120);
      expect(description.length).toBeLessThan(1024);
      expect(description.toLowerCase()).toMatch(/use (this )?(whenever|when|before)/);
    }
  });

  it("anchors every skill to a CCA-F domain rather than leaving the scope implicit", () => {
    for (const skill of skills) {
      expect(skill.body).toContain("## CCA-F domain");
    }
  });

  it("references only files that exist", () => {
    for (const skill of skills) {
      const referenced = [
        ...skill.raw.matchAll(/`?references\/([a-z0-9-]+\.md)`?/g)
      ].map((match) => join(skillsRoot, skill.name, "references", match[1] ?? ""));
      const scripts = [
        ...skill.raw.matchAll(/\.claude\/skills\/([a-z0-9-]+)\/scripts\/([a-z0-9-]+\.mjs)/g)
      ].map((match) => join(skillsRoot, match[1] ?? "", "scripts", match[2] ?? ""));
      for (const path of [...referenced, ...scripts]) {
        expect(() => accessSync(path, constants.R_OK), `${skill.name} references missing ${path}`).not.toThrow();
      }
    }
  });

  it("keeps every skill backed by an executable script rather than prose alone", () => {
    for (const skill of skills) {
      const scriptDirectory = join(skillsRoot, skill.name, "scripts");
      const scripts = readdirSync(scriptDirectory).filter((file) => file.endsWith(".mjs"));
      expect(scripts.length, `${skill.name} must ship at least one script`).toBeGreaterThan(0);
      for (const script of scripts) {
        const path = join(scriptDirectory, script);
        expect(() => accessSync(path, constants.X_OK), `${path} must be executable`).not.toThrow();
        const parsed = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
        expect(parsed.status, `${path} must parse: ${parsed.stderr}`).toBe(0);
      }
    }
  });

  it("never re-implements a control it should import from the compiled policy", () => {
    // A skill script that hardcodes a threshold becomes a second, divergent source of truth.
    const policyBacked = ["well-architected-review", "tokenomics-estimate", "promotion-evidence", "scenario-policy"];
    for (const name of policyBacked) {
      const scriptDirectory = join(skillsRoot, name, "scripts");
      const contents = readdirSync(scriptDirectory)
        .filter((file) => file.endsWith(".mjs"))
        .map((file) => read(join(scriptDirectory, file)))
        .join("\n");
      expect(contents, `${name} must import policy from dist/`).toContain("dist/src/");
    }
  });

  it("exposes each skill script as a reviewable npm entry point", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    for (const key of ["skills:check", "skills:boundaries", "skills:pillars", "skills:cost", "skills:evidence", "skills:probe", "skills:gates"]) {
      expect(scripts[key], `package.json must define ${key}`).toBeTruthy();
    }
    for (const skill of skills) {
      const scriptDirectory = join(skillsRoot, skill.name, "scripts");
      for (const script of readdirSync(scriptDirectory).filter((file) => file.endsWith(".mjs"))) {
        const path = `${scriptDirectory}/${script}`;
        expect(Object.values(scripts).some((command) => command.includes(path)), `${path} needs an npm entry`).toBe(true);
      }
    }
  });

  it("documents the whole set and its deterministic backing", () => {
    const readme = read(join(skillsRoot, "README.md"));
    for (const name of skillNames) expect(readme).toContain(name);
    expect(readme).toContain("certification blueprint");
  });
});

describe("trust-boundary scanner", () => {
  const scanner = join(skillsRoot, "cca-f-architecture-review", "scripts", "scan-boundaries.mjs");

  const scan = (root: string): { filesScanned: number; findings: Array<{ id: string; severity: string; file: string }> } => {
    const run = spawnSync(process.execPath, [scanner, "--json"], {
      encoding: "utf8",
      env: { ...process.env, RESIDENCY_ROOT: root }
    });
    return JSON.parse(run.stdout);
  };

  it("reports no boundary crossing in the repository as delivered", () => {
    const result = scan(process.cwd());
    expect(result.filesScanned).toBeGreaterThan(20);
    expect(result.findings).toEqual([]);
  });

  it("detects every encoded crossing so the scan cannot pass by being blind", () => {
    // Each line below is a deliberate violation of one documented boundary. If a rule stops
    // firing, the scanner would silently start approving the design it exists to question.
    const root = mkdtempSync(join(tmpdir(), "boundary-fixture-"));
    mkdirSync(join(root, "src", "agent"), { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "src", "agent", "workflow.ts"), [
      "const key = process.env.ANTHROPIC_API_KEY;",
      "const humanApprovalRequired = false;",
      'const severity = claudeRecommendation ? "low" : "high";',
      'console.log("intake", intake);',
      "const inputPerMillion = 3;",
      'await fetch("https://example.com/tool");',
      "const system = `You are helpful ${intake.useCase}`;"
    ].join("\n"));
    writeFileSync(join(root, "public", "app.js"), 'const k = "sk-ant-abc123def";\n');
    writeFileSync(join(root, "src", "evidence.json"), '{ "promptLogged": true }\n');

    const detected = new Set(scan(root).findings.map((finding) => finding.id));
    expect([...detected].sort()).toEqual([
      "AGY-B1", "AGY-B2", "COST-B1", "EVD-B1", "INP-B1", "NET-B1", "SEC-B1", "SEC-B2", "SEC-B3"
    ]);
  });

  it("fails the run only on a critical crossing so warnings do not become noise", () => {
    const root = mkdtempSync(join(tmpdir(), "boundary-severity-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "high-only.ts"), "const key = process.env.ANTHROPIC_API_KEY;\n");
    const high = spawnSync(process.execPath, [scanner], { encoding: "utf8", env: { ...process.env, RESIDENCY_ROOT: root } });
    expect(high.status).toBe(0);

    writeFileSync(join(root, "src", "critical.ts"), "const humanApprovalRequired = false;\n");
    const critical = spawnSync(process.execPath, [scanner], { encoding: "utf8", env: { ...process.env, RESIDENCY_ROOT: root } });
    expect(critical.status).toBe(1);
  });
});
