import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ATTESTATIONS, DEFAULT_CONFIG, DEFAULT_REQUIREMENTS, evalCondition, evaluate, OPS, renderReport, validateAttestations, validateRequirements } from "../tools/asbuilt.mjs";
import { authenticationKind, factsOf, VENDORS } from "../tools/asbuilt-vendors.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const config = () => load(DEFAULT_CONFIG);
const requirements = () => load(DEFAULT_REQUIREMENTS);
const attestations = () => load(DEFAULT_ATTESTATIONS);
const shipped = () => evaluate({ requirements: requirements(), config: config(), attestations: attestations() });
const verdicts = (result) => Object.fromEntries(result.results.map((r) => [r.id, r.verdict]));

/** One automated requirement, evaluated on its own. */
function one(fields, { cfg = config(), vendors = VENDORS } = {}) {
  const req = { id: "T-1", title: "test", source: "test", kind: "automated", ...fields };
  return evaluate({ requirements: { requirementSetId: "T", synthetic: true, requirements: [req] }, config: cfg, vendors }).results[0];
}

test("the shipped example gives exactly the verdicts the report shows", () => {
  assert.deepEqual(verdicts(shipped()), {
    "SYN-SEC-001": "met", "SYN-SEC-002": "unmet", "SYN-SEC-003": "indeterminable", "SYN-SEC-004": "indeterminable",
    "SYN-VPN-001": "met", "SYN-VPN-002": "met", "SYN-VPN-003": "met",
    "SYN-TLS-001": "indeterminable", "SYN-TLS-002": "met", "SYN-TLS-003": "met", "SYN-CERT-001": "met",
    "SYN-LB-001": "met", "SYN-LB-002": "met", "SYN-EDGE-001": "met",
    "SYN-DOC-001": "attested", "SYN-DOC-002": "needs_attestation", "SYN-CORE-001": "indeterminable"
  });
  assert.deepEqual(shipped().claim.counts, { met: 10, unmet: 1, indeterminable: 4, attested: 1, needs_attestation: 1, total: 17 });
});

test("a field the model does not carry is unknown, and unknown is never a pass", () => {
  assert.equal(evalCondition({ a: 1 }, { field: "missing", op: "eq", value: 1 }), "unknown");
  assert.equal(evalCondition({ a: null }, { field: "a", op: "eq", value: 1 }), "unknown");
  for (const op of ["gt", "gte", "lt", "lte"]) assert.equal(evalCondition({ a: "text" }, { field: "a", op, value: 1 }), "unknown", op);
  assert.equal(evalCondition({ a: "text" }, { field: "a", op: "lacksAny", value: ["x"] }), "unknown");
  assert.equal(evalCondition({}, { field: "a", op: "exists" }), "fail");
  assert.equal(evalCondition({}, { field: "a", op: "notExists" }), "pass");
  assert.equal(one({ fact: "firewallRules", assert: [{ field: "noSuchField", op: "eq", value: true }] }).verdict, "indeterminable");
});

test("every operator is exercised, and a wrong type never passes by accident", () => {
  const r = { n: 5, s: "TLSv1.2", list: ["a", "b"], flag: true, empty: [] };
  const cases = [
    ["eq", "flag", true, "pass"], ["eq", "flag", false, "fail"], ["ne", "n", 4, "pass"], ["in", "s", ["TLSv1.2", "TLSv1.3"], "pass"], ["notIn", "s", ["any"], "pass"],
    ["gt", "n", 4, "pass"], ["gte", "n", 5, "pass"], ["lt", "n", 5, "fail"], ["lte", "n", 5, "pass"], ["nonEmpty", "list", undefined, "pass"], ["nonEmpty", "empty", undefined, "fail"],
    ["lacksAny", "list", ["x"], "pass"], ["lacksAny", "list", ["a"], "fail"], ["containsAll", "list", ["a", "b"], "pass"], ["containsAll", "list", ["a", "c"], "fail"],
    ["startsWith", "s", "TLS", "pass"], ["endsWith", "s", "1.3", "fail"], ["eq", "n", "5", "fail"]
  ];
  assert.equal(new Set(cases.map((c) => c[0])).size, OPS.length - 2, "every operator except exists and notExists is covered here");
  for (const [op, field, value, expected] of cases) assert.equal(evalCondition(r, { field, op, ...(value === undefined ? {} : { value }) }), expected, `${op} ${field}`);
});

test("a failure outranks an unknown, and an unknown outranks a pass", () => {
  const mixed = one({ fact: "firewallRules", where: [{ field: "action", op: "eq", value: "allow" }], assert: [{ field: "noSuchField", op: "eq", value: true }, { field: "action", op: "eq", value: "deny" }] });
  assert.equal(mixed.verdict, "unmet", "one condition fails and one is unknown, so the record fails");
  const onlyUnknown = one({ fact: "firewallRules", assert: [{ field: "action", op: "in", value: ["allow", "deny"] }, { field: "noSuchField", op: "eq", value: 1 }] });
  assert.equal(onlyUnknown.verdict, "indeterminable");

  // Across records: Palo Alto fails outright while Meraki is merely unknown, because the model carries no Meraki source.
  const cfg = config();
  cfg.paloalto.rules[0].source = "any";
  const req = requirements().requirements.find((r) => r.id === "SYN-SEC-003");
  const result = evaluate({ requirements: { requirementSetId: "T", synthetic: true, requirements: [req] }, config: cfg }).results[0];
  assert.equal(result.perVendor.meraki, "unknown");
  assert.equal(result.perVendor.paloalto, "fail");
  assert.equal(result.verdict, "unmet", "a known violation is not hidden by an unknown elsewhere");
  assert.equal(shipped().results.find((r) => r.id === "SYN-SEC-003").verdict, "indeterminable", "without the violation it stays cannot-say");
});

test("it needs at least one matching record to claim anything, unless the author says otherwise", () => {
  const none = one({ fact: "loadBalancing", where: [{ field: "monitorType", op: "eq", value: "tcp" }], assert: [{ field: "memberCount", op: "gte", value: 1 }] });
  assert.equal(none.verdict, "unmet");
  assert.match(none.reason, /found 0 matching records, and 1 are needed/);
  const vacuous = one({ fact: "loadBalancing", minimum: 0, where: [{ field: "monitorType", op: "eq", value: "tcp" }], assert: [{ field: "memberCount", op: "gte", value: 1 }] });
  assert.equal(vacuous.verdict, "met");
});

test("a fact nobody supplies is not evaluable, not a failure", () => {
  const r = one({ fact: "wirelessSettings", assert: [{ field: "x", op: "eq", value: 1 }] });
  assert.equal(r.verdict, "indeterminable");
  assert.match(r.reason, /no vendor mapping supplies wirelessSettings/);
});

test("scoping a requirement to the vendors it applies to changes what can be claimed", () => {
  const assertion = [{ field: "minVersion", op: "in", value: ["TLSv1.2", "TLSv1.3"] }];
  assert.equal(one({ fact: "tlsEndpoints", assert: assertion }).verdict, "indeterminable", "Cloudflare carries no minimum TLS version");
  assert.equal(one({ fact: "tlsEndpoints", scope: { vendors: ["f5"] }, assert: assertion }).verdict, "met");
  const gap = one({ fact: "tlsEndpoints", scope: { vendors: ["f5", "cloudflare"] }, assert: assertion });
  assert.equal(gap.verdict, "indeterminable");
  assert.equal(gap.perVendor.cloudflare, "unknown");
});

test("a vendor the requirement names but the config lacks is a gap, while a vendor merely absent from the build is not", () => {
  const cfg = config();
  delete cfg.meraki;
  const named = one({ fact: "vpnTunnels", scope: { vendors: ["paloalto", "meraki"] }, assert: [{ field: "ikeVersion", op: "eq", value: 2 }] }, { cfg });
  assert.equal(named.verdict, "indeterminable");
  assert.match(named.reason, /the config has no section for meraki/);
  const unscoped = one({ fact: "vpnTunnels", assert: [{ field: "ikeVersion", op: "eq", value: 2 }] }, { cfg });
  assert.equal(unscoped.verdict, "met", "with no Meraki in the build, the one tunnel that exists is checked");
  const agree = one({ fact: "vpnTunnels", minimum: 2, agree: { field: "ikeVersion" } }, { cfg });
  assert.equal(agree.verdict, "indeterminable");
  assert.match(agree.reason, /needs at least two records to compare/);
});

test("a vendor can be added without changing a requirement, and the same requirement then gives an answer", () => {
  const req = requirements().requirements.find((r) => r.id === "SYN-CORE-001");
  const run = (cfg, vendors) => evaluate({ requirements: { requirementSetId: "T", synthetic: true, requirements: [req] }, config: cfg, vendors }).results[0];
  assert.equal(run(config(), VENDORS).verdict, "indeterminable", "before: no mapping for cisco-ios");
  assert.match(run(config(), VENDORS).reason, /no mapping for cisco-ios/);

  const withCisco = { ...VENDORS, "cisco-ios": { present: (c) => typeof c.ciscoIos === "object", provides: { managementAccess: (c) => [{ _path: "ciscoIos.vty", permittedSources: c.ciscoIos.vty.permittedSources, protocols: c.ciscoIos.vty.protocols }] } } };
  const cfg = config();
  assert.equal(run(cfg, withCisco).verdict, "indeterminable", "mapped, but the config has no section for it yet");
  assert.match(run(cfg, withCisco).reason, /no section for cisco-ios/);
  cfg.ciscoIos = { vty: { permittedSources: ["10.99.0.0/24"], protocols: ["ssh"] } };
  assert.equal(run(cfg, withCisco).verdict, "met");
  cfg.ciscoIos.vty.protocols = ["ssh", "telnet"];
  const failed = run(cfg, withCisco);
  assert.equal(failed.verdict, "unmet");
  assert.equal(failed.evidence[0].path, "ciscoIos.vty");
});

test("agreement across vendors is checked, and a disagreement names both ends", () => {
  const cfg = config();
  cfg.meraki.nonMerakiPeer.ikeVersion = 1;
  const result = evaluate({ requirements: requirements(), config: cfg, attestations: attestations() });
  const v = verdicts(result);
  assert.equal(v["SYN-VPN-001"], "unmet");
  assert.equal(v["SYN-VPN-002"], "unmet");
  const evidence = result.results.find((r) => r.id === "SYN-VPN-002").evidence;
  assert.deepEqual(evidence.map((e) => e.vendor).sort(), ["meraki", "paloalto"]);
  assert.deepEqual(evidence.map((e) => e.path).sort(), ["meraki.nonMerakiPeer", "paloalto.ipsec"]);
});

test("a literal pre-shared key is detected without being repeated anywhere", () => {
  const cfg = config();
  cfg.meraki.nonMerakiPeer.pskRef = "SENTINEL-LITERAL-KEY";
  const result = evaluate({ requirements: requirements(), config: cfg, attestations: attestations() });
  assert.equal(verdicts(result)["SYN-VPN-003"], "unmet");
  assert.ok(!JSON.stringify(result).includes("SENTINEL-LITERAL-KEY"));
  assert.ok(!renderReport(result).includes("SENTINEL-LITERAL-KEY"));
  assert.equal(authenticationKind("secret-store://x"), "secret-reference");
  assert.equal(authenticationKind("plain"), "literal");
  assert.equal(authenticationKind(undefined), "unknown");
});

test("evidence redacts secret-named fields", () => {
  const vendors = { demo: { present: () => true, provides: { thing: () => [{ _path: "demo", apiKey: "SENTINEL-VALUE", ok: true }] } } };
  const r = one({ fact: "thing", assert: [{ field: "apiKey", op: "exists" }, { field: "ok", op: "eq", value: true }] }, { vendors });
  assert.equal(r.evidence[0].fields.apiKey, "[redacted]");
  assert.ok(!JSON.stringify(r).includes("SENTINEL-VALUE"));
});

test("every record in the evidence cites a path that exists in the config", () => {
  const cfg = config();
  const resolve = (path) => path.split(".").reduce((o, part) => {
    const m = part.match(/^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/);
    const next = o?.[m[1]];
    return m[2] === undefined ? next : next?.[Number(m[2])];
  }, cfg);
  for (const [name, mapping] of Object.entries(VENDORS)) {
    assert.ok(mapping.present(cfg), `${name} is present in the reference config`);
    for (const [fact, extract] of Object.entries(mapping.provides)) {
      const records = extract(cfg);
      assert.ok(Array.isArray(records), `${name}.${fact} returns a list`);
      for (const rec of records) {
        assert.equal(typeof rec._path, "string", `${name}.${fact} record has a path`);
        assert.notEqual(resolve(rec._path), undefined, `${name}.${fact}: ${rec._path} does not resolve`);
      }
    }
  }
});

test("attestations count only on manual requirements, never override a machine check, and can expire", () => {
  const set = requirements();
  assert.deepEqual(validateAttestations(attestations(), set, "2026-11-18"), []);
  const onAutomated = { "SYN-SEC-002": { attestedBy: "role", date: "2026-11-01", reference: "ref" } };
  assert.match(validateAttestations(onAutomated, set, "2026-11-18").join(), /cannot override a machine check/);
  assert.throws(() => evaluate({ requirements: set, config: config(), attestations: onAutomated }), /cannot override a machine check/);
  assert.match(validateAttestations({ "NOPE-1": { attestedBy: "role", date: "2026-11-01", reference: "ref" } }, set, "2026-11-18").join(), /does not match a requirement/);
  assert.match(validateAttestations({ "SYN-DOC-001": { attestedBy: "role", date: "2027-01-01", reference: "ref" } }, set, "2026-11-18").join(), /after the as-of date/);
  assert.match(validateAttestations({ "SYN-DOC-001": { attestedBy: "role", date: "2026-11-01", reference: "ref", extra: 1 } }, set, "2026-11-18").join(), /may only have/);
  const expired = { "SYN-DOC-001": { attestedBy: "role", date: "2026-01-01", reference: "ref", validUntil: "2026-06-30" } };
  const r = evaluate({ requirements: set, config: config(), attestations: expired }).results.find((x) => x.id === "SYN-DOC-001");
  assert.equal(r.verdict, "needs_attestation");
  assert.match(r.reason, /expired/);
  assert.equal(shipped().results.find((x) => x.id === "SYN-DOC-001").attestation.reference, "SYNTH-REVIEW-0042, diagram v3");
});

test("validation is strict: unknown keys and operators, bad shapes, and duplicates are errors that do not echo values", () => {
  const bad = (mutate) => {
    const s = requirements();
    mutate(s);
    return validateRequirements(s);
  };
  const cases = [
    (s) => { s.requirements[0].asert = []; },
    (s) => { s.requirements[0].assert[0].op = "matches"; },
    (s) => { s.requirements[0].assert[0].op = "eq"; delete s.requirements[0].assert[0].value; },
    (s) => { s.requirements[0].assert[1].value = "not-a-list"; },
    (s) => { s.requirements[0].assert[0].extra = 1; },
    (s) => { s.requirements[0].assert[0].field = "a b"; },
    (s) => { s.requirements[0].assert[0].field = "a.b.c.d.e.f"; },
    (s) => { delete s.requirements[0].assert; },
    (s) => { s.requirements[0].agree = { field: "x" }; },
    (s) => { s.requirements[1].id = s.requirements[0].id; },
    (s) => { s.requirements[0].id = "has space"; },
    (s) => { s.requirements[0].kind = "semi"; },
    (s) => { s.requirements[0].fact = "bad fact"; },
    (s) => { s.requirements[0].minimum = -1; },
    (s) => { s.requirements[0].scope = { vendors: ["UPPER"] }; },
    (s) => { s.requirements[0].scope = { vendors: [] }; },
    (s) => { s.requirements[0].scope = { vendors: ["f5"], extra: 1 }; },
    (s) => { s.requirements[14].fact = "managementAccess"; },
    (s) => { s.requirements[0].evidence = "x"; },
    (s) => { s.requirements[14].evidence = ""; },
    (s) => { s.requirements = []; },
    (s) => { s.requirements = new Array(501).fill(s.requirements[0]); },
    (s) => { delete s.requirementSetId; },
    (s) => { delete s.synthetic; },
    (s) => { s.requirements[0].title = "x".repeat(201); }
  ];
  for (const mutate of cases) assert.ok(bad(mutate).length > 0, mutate.toString());
  assert.deepEqual(validateRequirements(null), ["requirements must be a JSON object"]);
  const hostile = requirements();
  hostile.requirements[0].SENTINEL_KEY = 1;
  hostile.requirements[1].id = "SENTINEL value";
  assert.ok(!validateRequirements(hostile).join("\n").includes("SENTINEL value"));
  assert.deepEqual(validateRequirements(requirements()), []);
});

test("an invalid requirement set stops the claim instead of producing a partial one", () => {
  const set = requirements();
  set.requirements[3].op = "x";
  set.requirements[0].assert[0].op = "matches";
  assert.throws(() => evaluate({ requirements: set, config: config() }), /invalid input/);
  assert.throws(() => evaluate({ requirements: requirements(), config: { ...config(), referenceDate: undefined } }), /as-of date is required/);
  assert.equal(evaluate({ requirements: requirements(), config: { ...config(), referenceDate: undefined }, asOf: "2026-11-18" }).claim.asOf, "2026-11-18");
});

test("the claim is bound to digests of the config and the requirements, and is deterministic", () => {
  const a = shipped();
  assert.deepEqual(a, shipped());
  assert.match(a.claim.configDigest, /^[0-9a-f]{64}$/);
  const cfg = config();
  cfg.f5.pool.method = "least-connections";
  assert.notEqual(evaluate({ requirements: requirements(), config: cfg, attestations: attestations() }).claim.configDigest, a.claim.configDigest);
  const set = requirements();
  set.requirements[0].title = "changed";
  assert.notEqual(evaluate({ requirements: set, config: config(), attestations: attestations() }).claim.requirementsDigest, a.claim.requirementsDigest);
  assert.ok(renderReport(a).includes(a.claim.configDigest));
});

test("the report speaks only for the modeled config, says what it cannot claim, and escapes requirement text", () => {
  const report = renderReport(shipped());
  assert.match(report, /does not say the real devices match that configuration/);
  assert.match(report, /"Indeterminable" is neither a pass nor a failure/);
  assert.match(report, /An attestation is a person's statement and is never counted as a machine check/);
  assert.match(report, /## Where the claim stops, and why/);
  const set = { requirementSetId: "T", synthetic: true, requirements: [{ id: "T-1", title: "a | b\nc <script>", source: "s", kind: "manual" }] };
  const hostile = renderReport(evaluate({ requirements: set, config: config() }));
  assert.ok(!hostile.includes("<script>"));
  assert.ok(hostile.split("\n").some((line) => line.includes("a \\| b c &lt;script&gt;") && line.startsWith("| T-1")));
});

test("a backslash in a title cannot cancel the pipe escape and break out of its table cell", () => {
  const set = { requirementSetId: "T", synthetic: true, requirements: [{ id: "T-1", title: "a\\| b", source: "s", kind: "manual" }] };
  const line = renderReport(evaluate({ requirements: set, config: config() })).split("\n").find((l) => l.startsWith("| T-1"));
  assert.ok(line.includes("a\\\\\\| b"));
});

test("the committed report is exactly what the engine produces", () => {
  assert.equal(readFileSync(join(root, "docs", "ASBUILT_REPORT.md"), "utf8"), renderReport(shipped()));
});

test("the docs name every fact the vendor mappings supply, and no other", () => {
  const doc = readFileSync(join(root, "docs", "ASBUILT_REQUIREMENTS.md"), "utf8");
  const documented = [...doc.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(documented, Object.keys(factsOf()).sort());
});

function cli(args) {
  const result = spawnSync("node", [join(root, "tools", "asbuilt.mjs"), ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("CLI: prints the report, supports JSON, and --fail-on gates on what was not claimed", () => {
  assert.match(cli([]).out, /# As-built requirements claim/);
  assert.equal(JSON.parse(cli(["--json"]).out).claim.counts.total, 17);
  assert.equal(cli([]).status, 0);
  assert.equal(cli(["--fail-on=unmet"]).status, 1);
  assert.equal(cli(["--fail-on=not_claimed"]).status, 1);
});

test("CLI: real customer data is accepted only from *.client.json files and never written to a report file", () => {
  const dir = mkdtempSync(join(tmpdir(), "twin-asbuilt-"));
  try {
    const req = { ...requirements(), synthetic: false };
    const att = attestations();
    const w = (name, value) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const plainReq = w("req.json", req);
    const plainCfg = w("cfg.json", config());
    const clientReq = w("acme.client.json", req);
    const clientCfg = w("acme-config.client.json", config());
    const clientAtt = w("acme-att.client.json", att);
    assert.equal(cli([`--requirements=${plainReq}`, `--config=${plainCfg}`, `--attestations=${clientAtt}`]).status, 2);
    assert.match(cli([`--requirements=${plainReq}`, `--config=${plainCfg}`]).err, /\*\.client\.json/);
    assert.equal(cli([`--requirements=${clientReq}`, `--config=${plainCfg}`, `--attestations=${clientAtt}`]).status, 2, "every file must be a client file");
    const ok = cli([`--requirements=${clientReq}`, `--config=${clientCfg}`, `--attestations=${clientAtt}`]);
    assert.equal(ok.status, 0);
    assert.match(ok.out, /Real customer data/);
    assert.equal(cli([`--requirements=${clientReq}`, `--config=${clientCfg}`, `--attestations=${clientAtt}`, `--out=${join(dir, "report.md")}`]).status, 2);
    assert.throws(() => readFileSync(join(dir, "report.md")));
    const realConfig = w("real-config.client.json", { ...config(), twinId: "ACME-PROD" });
    const syntheticReq = w("synthetic.client.json", requirements());
    assert.match(cli([`--requirements=${syntheticReq}`, `--config=${realConfig}`, `--attestations=${clientAtt}`]).out, /Real customer data/, "a non-synthetic config also marks the claim as real");
    assert.equal(cli([`--requirements=${requirementsPlain(dir, requirements())}`, `--config=${w("real2.json", { ...config(), twinId: "ACME-PROD" })}`]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function requirementsPlain(dir, value) {
  const path = join(dir, "plain-req.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("CLI: unreadable or invalid input fails cleanly without echoing it", () => {
  assert.equal(cli(["--requirements=/nonexistent.json"]).status, 2);
  const dir = mkdtempSync(join(tmpdir(), "twin-asbuilt-"));
  try {
    const bad = requirements();
    bad.requirements[0].assert[0].op = "SENTINEL-OP";
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify(bad));
    const result = cli([`--requirements=${path}`, "--attestations=" + DEFAULT_ATTESTATIONS]);
    assert.equal(result.status, 2);
    assert.match(result.err, /invalid input/);
    assert.ok(!result.err.includes("SENTINEL-OP"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
