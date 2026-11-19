import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, DEFAULT_CONFIG, renderMarkdown, renderMermaid } from "../tools/render-topology.mjs";
import { buildChangeSet, renderIac } from "../tools/render-iac.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const reference = () => JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
const edgeBetween = (graph, from, to) => graph.edges.find((edge) => edge.from === from && edge.to === to);

test("the topology draws each allow rule as an edge between zones, with NAT on the edge rule", () => {
  const graph = buildGraph(reference());
  assert.match(edgeBetween(graph, "z_untrust", "z_dmz").label, /edge-https.*tcp\/443.*NAT to 10\.20\.0\.100:443/);
  assert.match(edgeBetween(graph, "z_vpn_branch", "z_dmz").label, /branch-https/);
  assert.match(edgeBetween(graph, "z_dmz", "z_app").label, /f5-to-pool.*tcp\/8080/);
  assert.equal(edgeBetween(graph, "mx", "z_vpn_branch").kind, "thick");
  assert.equal(graph.edges.filter((edge) => edge.danger).length, 0);
});

test("the topology marks a path into the app zone from outside dmz", () => {
  const config = reference();
  config.paloalto.rules.splice(3, 0, { name: "branch-to-pool", from: "vpn-branch", to: "app", source: "10.40.0.0/24", destination: "10.30.0.0/24", service: "tcp/8080", action: "allow", log: true });
  const graph = buildGraph(config);
  const flagged = graph.edges.filter((edge) => edge.danger);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].from, "z_vpn_branch");
  assert.equal(flagged[0].to, "z_app");
  assert.match(renderMermaid(config), /linkStyle \d+ stroke:#d33/);
});

test("the topology grows as the config is built", () => {
  assert.match(renderMermaid({}), /No sections built yet/);
  const partial = reference();
  delete partial.cloudflare;
  delete partial.meraki;
  const text = renderMermaid(partial);
  assert.ok(!text.includes("Cloudflare edge"));
  assert.ok(!text.includes("Meraki MX"));
  assert.ok(text.includes("F5 virtual server"));
  assert.ok(text.includes("zone untrust"));
});

test("config text cannot alter the diagram syntax", () => {
  const baseline = renderMermaid(reference()).split("\n").length;
  const config = reference();
  config.cloudflare.dns.name = 'x"]\n  click user "javascript:alert(1)"\n  user["';
  config.paloalto.rules[0].name = "r|}\n%%{init}";
  const text = renderMermaid(config);
  assert.equal(text.split("\n").length, baseline, "no new lines may be introduced");
  assert.ok(!/^\s*click\b/m.test(text));
  assert.ok(!/<script/i.test(text));
});

test("docs/TOPOLOGY.md is exactly what the renderer produces", () => {
  assert.equal(readFileSync(join(root, "docs", "TOPOLOGY.md"), "utf8"), renderMarkdown(reference()));
});

test("IaC rendering refuses an unhealthy config and writes nothing", () => {
  const config = reference();
  config.cloudflare.ssl.mode = "flexible";
  assert.throws(() => renderIac(config), /refusing to render: stage 08 is unhealthy \(HC-08-SSLMODE\)/);
  const dir = mkdtempSync(join(tmpdir(), "twin-iac-"));
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(config));
    const result = spawnSync("node", [join(root, "tools", "render-iac.mjs"), `--config=${bad}`, `--out=${join(dir, "out")}`], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.throws(() => readFileSync(join(dir, "out", "changeset.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed rendered/ files are exactly what the renderer produces", () => {
  const files = renderIac(reference());
  assert.equal(Object.keys(files).length, 10);
  for (const [path, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(root, "rendered", path), "utf8"), content, `${path} has drifted; run npm run render:iac`);
  }
});

test("rendering is deterministic", () => {
  assert.deepEqual(renderIac(reference()), renderIac(reference()));
});

test("the change set is ordered by stage, keeps rule order, and only creates", () => {
  const ops = buildChangeSet(reference());
  assert.equal(ops.length, 35);
  assert.deepEqual(ops.map((op) => op.order), ops.map((_, index) => index + 1));
  const stages = ops.map((op) => op.stage);
  assert.deepEqual(stages, [...stages].sort());
  assert.ok(ops.every((op) => op.action === "create"));
  const rules = ops.filter((op) => op.object === "security-rule");
  assert.deepEqual(rules.map((op) => op.name), ["edge-https", "branch-https", "f5-to-pool", "default-deny"]);
  assert.deepEqual(rules.map((op) => op.attributes.position), [1, 2, 3, 4]);
  assert.deepEqual([...new Set(ops.map((op) => op.vendor))].sort(), ["cloudflare", "f5", "meraki", "paloalto"]);
});

test("the pre-shared key stays a secret-store reference in the change set", () => {
  const refs = buildChangeSet(reference()).map((op) => op.attributes.pskRef).filter(Boolean);
  assert.equal(refs.length, 2);
  assert.ok(refs.every((ref) => ref.startsWith("secret-store://")));
});

test("rendered Terraform carries no credential, key material, or sensitive default", () => {
  const files = renderIac(reference());
  const all = Object.values(files).join("\n");
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(all));
  assert.match(files["terraform/f5/versions.tf"], /password = var\.bigip_password/);
  const variables = files["terraform/f5/variables.tf"];
  for (const name of ["bigip_username", "bigip_password", "certificate_pem", "private_key_pem"]) {
    const declaration = variables.slice(variables.indexOf(`variable "${name}"`)).split("\n}\n")[0];
    assert.match(declaration, /sensitive\s*=\s*true/, `${name} must be sensitive`);
    assert.ok(!/default\s*=/.test(declaration), `${name} must have no default`);
  }
  assert.match(files["terraform/cloudflare/versions.tf"], /provider "cloudflare" \{\}/);
});

test("config text cannot become an HCL interpolation", () => {
  const config = reference();
  const host = "a${evil}b%{evil}.lab.example";
  config.hostname = host;
  config.tls.certificate.subject = host;
  config.cloudflare.dns.name = host;
  config.f5.pool.monitor.send = `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
  // Only HCL files matter here. changeset.json is plain JSON, where "${" has no meaning.
  const all = Object.entries(renderIac(config)).filter(([path]) => /\.(tf|hcl)$/.test(path)).map(([, content]) => content).join("\n");
  assert.ok(all.includes("$${evil}"));
  assert.ok(!/(^|[^$])\$\{evil\}/.test(all), "a bare interpolation leaked");
  assert.ok(!/(^|[^%])%\{evil\}/.test(all), "a bare template directive leaked");
});

test("each plan test asserts the values the twin declares", () => {
  const files = renderIac(reference());
  assert.match(files["terraform/cloudflare/tests/plan.tftest.hcl"], /mock_provider "cloudflare"/);
  assert.match(files["terraform/cloudflare/tests/plan.tftest.hcl"], /== "strict"/);
  assert.match(files["terraform/f5/tests/plan.tftest.hcl"], /mock_provider "bigip"/);
  assert.match(files["terraform/f5/tests/plan.tftest.hcl"], /destination == "10\.20\.0\.100"/);
  for (const path of Object.keys(files).filter((name) => name.endsWith(".tftest.hcl"))) assert.match(files[path], /command = plan/);
});

const hasTerraform = spawnSync("terraform", ["version"], { encoding: "utf8" }).status === 0;
test("rendered HCL passes terraform fmt (syntax and formatting)", { skip: !hasTerraform && "terraform is not installed" }, () => {
  const result = spawnSync("terraform", ["fmt", "-check", "-recursive", join(root, "rendered", "terraform")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
