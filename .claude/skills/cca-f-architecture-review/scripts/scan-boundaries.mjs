#!/usr/bin/env node
// Deterministic trust-boundary scanner for the residency architecture.
//
// Every rule encodes an invariant from SECURITY.md, docs/ARCHITECTURE.md, or CLAUDE.md
// that a reviewer would otherwise have to re-check by eye on every change. The scan is
// static and offline: it reports where a boundary is crossed, never whether the crossing
// was intentional. A finding is a prompt for human judgement, not an automatic rejection.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repoRoot = process.env.RESIDENCY_ROOT ?? process.cwd();
const args = process.argv.slice(2);
const json = args.includes("--json");
const pathArg = args.find((arg) => arg.startsWith("--paths="))?.split("=")[1];
const roots = (pathArg ? pathArg.split(",") : ["src", "public", "scripts", "infra", "examples", "config"])
  .map((entry) => entry.trim())
  .filter(Boolean);

const skipDirectories = new Set(["node_modules", "dist", ".git", "coverage", ".claude"]);
const scannable = /\.(ts|mts|js|mjs|cjs|tf|hcl|json|html|css|sh|env)$/;

// Each rule names the boundary it protects and the one place the crossing is legitimate.
const rules = [
  {
    id: "SEC-B1",
    boundary: "browser / server secret custody",
    severity: "critical",
    source: "SECURITY.md: no client-side or committed secrets",
    pattern: /ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|sk-ant-[A-Za-z0-9-]+|BEGIN (?:RSA |EC )?PRIVATE KEY/,
    applies: (path) => path.startsWith(`public${sep}`),
    message: "A credential identifier appears in browser-delivered code."
  },
  {
    id: "SEC-B2",
    boundary: "model-adapter secret containment",
    severity: "high",
    source: "docs/ARCHITECTURE.md: the model adapter is the only credential reader",
    pattern: /process\.env\.ANTHROPIC_API_KEY/,
    applies: (path) => path.startsWith(`src${sep}`) && path !== `src${sep}agent${sep}claude.ts`,
    message: "The Anthropic credential is read outside the single model adapter."
  },
  {
    id: "SEC-B3",
    boundary: "log / sensitive-content separation",
    severity: "high",
    source: "SECURITY.md: logs carry metadata and control outcomes, not prompt bodies",
    pattern: /console\.(log|info|warn|error)\([^)]*\b(narrative|prompt|promptBody|messages|intake|claimNarrative|requestBody)\b/,
    applies: (path) => path.startsWith(`src${sep}`) || path.startsWith(`scripts${sep}`),
    message: "A log statement may emit prompt or narrative content rather than metadata."
  },
  {
    id: "AGY-B1",
    boundary: "deterministic control vs. model reasoning",
    severity: "critical",
    source: "docs/ARCHITECTURE.md: Claude never authorizes its own tools or suppresses findings",
    pattern: /(humanApprovalRequired|deploymentAuthorized|authorized|severity)\s*[:=]\s*[^;,\n]*\b(recommendation|claudeRecommendation|modelText|completion|modelOutput)\b/,
    applies: (path) => path.startsWith(`src${sep}`),
    message: "Model output appears to determine an approval, authorization, or severity value."
  },
  {
    id: "AGY-B2",
    boundary: "human approval and deployment authority",
    severity: "critical",
    source: "SECURITY.md: explicit human approval for consequential actions",
    pattern: /humanApprovalRequired"?\s*[:=]\s*false|deploymentAuthorized"?\s*[:=]\s*true/,
    applies: (path) => path.startsWith(`src${sep}`) || path.startsWith(`scripts${sep}`) || path.startsWith(`examples${sep}`),
    message: "Human approval is waived or deployment is self-authorized in code or fixtures."
  },
  {
    id: "EVD-B1",
    boundary: "evidence integrity",
    severity: "high",
    source: "CLAUDE.md rule 7: evidence metadata excludes prompt bodies",
    pattern: /promptLogged"?\s*[:=]\s*true|sensitiveContentLogged"?\s*[:=]\s*true/,
    applies: (path) => path.startsWith(`src${sep}`) || path.startsWith(`examples${sep}`),
    message: "An evidence envelope declares that prompt or sensitive content was logged."
  },
  {
    id: "COST-B1",
    boundary: "operator-supplied pricing",
    severity: "high",
    source: "CLAUDE.md rule 5: pricing is deterministic and operator-supplied",
    pattern: /(inputPerMillion|outputPerMillion|costPerMtok|pricePerToken)"?\s*[:=]\s*[0-9]/,
    applies: (path) => path.startsWith(`src${sep}`) && path !== `src${sep}agent${sep}cost.ts`,
    message: "Model pricing is hardcoded instead of read from operator configuration."
  },
  {
    id: "NET-B1",
    boundary: "default-deny egress",
    severity: "high",
    source: "SECURITY.md: default-deny external tools and egress",
    pattern: /fetch\(\s*["'`]https?:\/\//,
    applies: (path) => (path.startsWith(`src${sep}`) || path.startsWith(`scripts${sep}`)) && path !== `src${sep}agent${sep}claude.ts`,
    message: "An outbound network call is made outside the reviewed model adapter."
  },
  {
    id: "INP-B1",
    boundary: "untrusted intake",
    severity: "high",
    source: "CLAUDE.md rule 4: intake fields are data, never instructions",
    pattern: /system\s*[:=]\s*`[^`]*\$\{|system\s*[:=]\s*[^,\n]*\+\s*(intake|input|narrative|useCase)/,
    applies: (path) => path.startsWith(`src${sep}`),
    message: "Intake data appears to be interpolated into a system prompt, where it would read as instruction."
  }
];

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(resolve(repoRoot, directory));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (skipDirectories.has(entry)) continue;
    const relativePath = `${directory}${sep}${entry}`;
    const absolute = resolve(repoRoot, relativePath);
    if (statSync(absolute).isDirectory()) yield* walk(relativePath);
    else if (scannable.test(entry)) yield relativePath;
  }
}

const findings = [];
let scanned = 0;

for (const root of roots) {
  let rootStat;
  try {
    rootStat = statSync(resolve(repoRoot, root));
  } catch {
    continue;
  }
  const files = rootStat.isDirectory() ? [...walk(root)] : [root];
  for (const file of files) {
    const normalized = relative(repoRoot, resolve(repoRoot, file));
    const lines = readFileSync(resolve(repoRoot, file), "utf8").split("\n");
    scanned += 1;
    for (const rule of rules) {
      if (!rule.applies(normalized)) continue;
      lines.forEach((line, index) => {
        if (!rule.pattern.test(line)) return;
        findings.push({
          id: rule.id,
          severity: rule.severity,
          boundary: rule.boundary,
          source: rule.source,
          message: rule.message,
          file: normalized,
          line: index + 1,
          evidence: line.trim().slice(0, 160)
        });
      });
    }
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", filesScanned: scanned, findings }, null, 2)}\n`);
} else if (findings.length === 0) {
  process.stdout.write(`Scanned ${scanned} file(s) across ${roots.join(", ")}.\nNo trust-boundary crossings detected by the ${rules.length} encoded rules.\n`);
  process.stdout.write("This scan is static: it cannot prove a design is safe, only that these known crossings are absent.\n");
} else {
  process.stdout.write(`Scanned ${scanned} file(s). ${findings.length} boundary finding(s):\n\n`);
  for (const finding of findings) {
    process.stdout.write(`${finding.severity.toUpperCase()} ${finding.id}  ${finding.file}:${finding.line}\n`);
    process.stdout.write(`  boundary: ${finding.boundary}\n`);
    process.stdout.write(`  ${finding.message}\n`);
    process.stdout.write(`  basis: ${finding.source}\n`);
    process.stdout.write(`  code: ${finding.evidence}\n\n`);
  }
  process.stdout.write("Explain each finding as intentional with its compensating control, or remove the crossing.\n");
}

if (findings.some((finding) => finding.severity === "critical")) process.exitCode = 1;
