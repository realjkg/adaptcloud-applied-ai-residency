#!/usr/bin/env node
// Claim against customer as-built requirements, exactly and across vendors.
//
// A requirement says what must be true of the build, in the customer's own words and ids. The engine checks it
// against vendor-neutral facts drawn from the twin config, and returns one verdict per requirement:
//
//   met            machine-checked against the config, with evidence for every record considered
//   unmet        at least one record violates it, with the record named
//   indeterminable  the config cannot answer it, and the report says what is missing
//   attested       a named role attested on a date with a reference. Not machine-checked, and labeled as such
//   manual         needs a human attestation and has none
//
// Rules that keep a claim exact:
//   - A field the model does not carry is unknown. Unknown is never a pass, so silence cannot become "met".
//   - A failure outranks an unknown. A requirement is met only when every record it considered passed.
//   - An attestation applies only to a manual requirement. It can never override a machine check.
//   - Operators and keys are a closed set. An unrecognized one is an error, so a typo cannot weaken a requirement.
//   - A claim is bound to a digest of the config and of the requirements, and speaks only for the modeled config.
//
// Pure apart from reading files. No eval, no regular expressions from requirement files, no network.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableStringify } from "./provision-policy.mjs";
import { VENDORS as DEFAULT_VENDORS, factsOf } from "./asbuilt-vendors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REQUIREMENTS = join(HERE, "..", "requirements", "example-asbuilt.json");
export const DEFAULT_ATTESTATIONS = join(HERE, "..", "requirements", "example-attestations.json");
export const DEFAULT_CONFIG = join(HERE, "..", "config", "twin-config.json");

export const OPS = ["eq", "ne", "in", "notIn", "gt", "gte", "lt", "lte", "exists", "notExists", "nonEmpty", "lacksAny", "containsAll", "startsWith", "endsWith"];
const ARRAY_VALUE_OPS = ["in", "notIn", "lacksAny", "containsAll"];
const NUMBER_VALUE_OPS = ["gt", "gte", "lt", "lte"];
const STRING_VALUE_OPS = ["startsWith", "endsWith"];
const NO_VALUE_OPS = ["exists", "notExists", "nonEmpty"];

const ID = /^[A-Za-z0-9._-]{1,40}$/;
const FACT = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,40}(\.[A-Za-z_][A-Za-z0-9_]{0,40}){0,3}$/;
const VENDOR = /^[a-z0-9][a-z0-9-]{0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_FIELD = /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|psk/i;
const REQUIREMENT_KEYS = ["id", "title", "source", "kind", "scope", "fact", "where", "assert", "agree", "minimum", "evidence"];
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const known = (v) => v !== undefined && v !== null;
const sha = (value) => createHash("sha256").update(stableStringify(value)).digest("hex");
const same = (a, b) => stableStringify(a) === stableStringify(b);
const text = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;

function conditionProblems(conditions, label, problems) {
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 20) {
    problems.push(`${label} must be a list of 1 to 20 conditions`);
    return;
  }
  conditions.forEach((c, i) => {
    const at = `${label}[${i}]`;
    if (!isObject(c) || Object.keys(c).some((k) => !["field", "op", "value"].includes(k))) return problems.push(`${at} may only have field, op, and value`);
    if (typeof c.field !== "string" || !FIELD.test(c.field)) problems.push(`${at}.field is not a valid field path`);
    if (!OPS.includes(c.op)) return problems.push(`${at}.op is not a known operator`);
    if (ARRAY_VALUE_OPS.includes(c.op) && !(Array.isArray(c.value) && c.value.length > 0 && c.value.length <= 50)) problems.push(`${at}.value must be a list of 1 to 50 for this operator`);
    if (NUMBER_VALUE_OPS.includes(c.op) && !(typeof c.value === "number" && Number.isFinite(c.value))) problems.push(`${at}.value must be a number for this operator`);
    if (STRING_VALUE_OPS.includes(c.op) && !text(c.value, 100)) problems.push(`${at}.value must be a string for this operator`);
    if (NO_VALUE_OPS.includes(c.op) && "value" in c) problems.push(`${at}.value is not allowed for this operator`);
    if (["eq", "ne"].includes(c.op) && !("value" in c)) problems.push(`${at}.value is required for this operator`);
  });
}

/** Returns a list of problems. Messages name fields and positions, never values. */
export function validateRequirements(set) {
  const problems = [];
  if (!isObject(set)) return ["requirements must be a JSON object"];
  if (!text(set.requirementSetId, 60)) problems.push("requirementSetId must be 1 to 60 characters");
  if (typeof set.synthetic !== "boolean") problems.push("synthetic must be true or false");
  const list = set.requirements;
  if (!Array.isArray(list) || list.length < 1 || list.length > 500) return [...problems, "requirements must be a list of 1 to 500 entries"];
  const ids = new Set();
  list.forEach((r, i) => {
    const at = `requirements[${i}]`;
    if (!isObject(r)) return problems.push(`${at} must be an object`);
    for (const key of Object.keys(r)) if (!REQUIREMENT_KEYS.includes(key)) problems.push(`${at} has an unknown key ${JSON.stringify(key.slice(0, 20))}`);
    if (typeof r.id !== "string" || !ID.test(r.id)) problems.push(`${at}.id must be 1 to 40 letters, digits, or . _ -`);
    else if (ids.has(r.id)) problems.push(`${at}.id is a duplicate`);
    else ids.add(r.id);
    if (!text(r.title, 200)) problems.push(`${at}.title must be 1 to 200 characters`);
    if (!text(r.source, 200)) problems.push(`${at}.source must be 1 to 200 characters`);
    if (!["automated", "manual"].includes(r.kind)) return problems.push(`${at}.kind must be automated or manual`);
    if (r.scope !== undefined) {
      if (!isObject(r.scope) || Object.keys(r.scope).some((k) => k !== "vendors") || !Array.isArray(r.scope.vendors) || r.scope.vendors.length < 1 || r.scope.vendors.length > 20 || r.scope.vendors.some((v) => typeof v !== "string" || !VENDOR.test(v))) problems.push(`${at}.scope must be { vendors: [1 to 20 vendor names] }`);
    }
    if (r.kind === "manual") {
      for (const key of ["fact", "where", "assert", "agree", "minimum"]) if (key in r) problems.push(`${at}.${key} is not allowed on a manual requirement`);
      if (r.evidence !== undefined && !text(r.evidence, 300)) problems.push(`${at}.evidence must be 1 to 300 characters`);
      return;
    }
    if ("evidence" in r) problems.push(`${at}.evidence is only for manual requirements`);
    if (typeof r.fact !== "string" || !FACT.test(r.fact)) problems.push(`${at}.fact must be a fact name`);
    if (r.where !== undefined) conditionProblems(r.where, `${at}.where`, problems);
    const hasAssert = r.assert !== undefined;
    const hasAgree = r.agree !== undefined;
    if (hasAssert === hasAgree) problems.push(`${at} needs exactly one of assert or agree`);
    if (hasAssert) conditionProblems(r.assert, `${at}.assert`, problems);
    if (hasAgree && (!isObject(r.agree) || Object.keys(r.agree).some((k) => k !== "field") || typeof r.agree.field !== "string" || !FIELD.test(r.agree.field))) problems.push(`${at}.agree must be { field }`);
    if (r.minimum !== undefined && !(Number.isInteger(r.minimum) && r.minimum >= 0 && r.minimum <= 1000)) problems.push(`${at}.minimum must be an integer from 0 to 1000`);
  });
  return problems;
}

/** Attestations are keyed by requirement id. They can only attach to a manual requirement. */
export function validateAttestations(attestations, set, asOf) {
  const problems = [];
  if (!isObject(attestations)) return ["attestations must be a JSON object keyed by requirement id"];
  const byId = new Map((Array.isArray(set?.requirements) ? set.requirements : []).map((r) => [r.id, r]));
  for (const [id, a] of Object.entries(attestations)) {
    const at = `attestations[${JSON.stringify(id.slice(0, 40))}]`;
    const requirement = byId.get(id);
    if (!requirement) problems.push(`${at} does not match a requirement`);
    else if (requirement.kind !== "manual") problems.push(`${at} targets an automated requirement, and an attestation cannot override a machine check`);
    if (!isObject(a) || Object.keys(a).some((k) => !["attestedBy", "date", "reference", "validUntil"].includes(k))) {
      problems.push(`${at} may only have attestedBy, date, reference, and validUntil`);
      continue;
    }
    if (!text(a.attestedBy, 80)) problems.push(`${at}.attestedBy must be 1 to 80 characters (a role, not a personal detail)`);
    if (!text(a.reference, 120)) problems.push(`${at}.reference must be 1 to 120 characters`);
    if (typeof a.date !== "string" || !DATE.test(a.date) || Number.isNaN(Date.parse(a.date))) problems.push(`${at}.date must be YYYY-MM-DD`);
    else if (asOf && a.date > asOf) problems.push(`${at}.date is after the as-of date`);
    if (a.validUntil !== undefined && (typeof a.validUntil !== "string" || !DATE.test(a.validUntil) || Number.isNaN(Date.parse(a.validUntil)))) problems.push(`${at}.validUntil must be YYYY-MM-DD`);
  }
  return problems;
}

const valueAt = (record, path) => path.split(".").reduce((o, k) => (isObject(o) ? o[k] : undefined), record);

/** pass, fail, or unknown. A value the record does not carry is unknown, never a pass. */
export function evalCondition(record, cond) {
  const v = valueAt(record, cond.field);
  if (cond.op === "exists") return known(v) ? "pass" : "fail";
  if (cond.op === "notExists") return known(v) ? "fail" : "pass";
  if (!known(v)) return "unknown";
  const verdict = (ok) => (ok ? "pass" : "fail");
  switch (cond.op) {
    case "eq": return verdict(same(v, cond.value));
    case "ne": return verdict(!same(v, cond.value));
    case "in": return verdict(cond.value.some((x) => same(v, x)));
    case "notIn": return verdict(!cond.value.some((x) => same(v, x)));
    case "gt": return typeof v === "number" ? verdict(v > cond.value) : "unknown";
    case "gte": return typeof v === "number" ? verdict(v >= cond.value) : "unknown";
    case "lt": return typeof v === "number" ? verdict(v < cond.value) : "unknown";
    case "lte": return typeof v === "number" ? verdict(v <= cond.value) : "unknown";
    case "nonEmpty": return Array.isArray(v) || typeof v === "string" ? verdict(v.length > 0) : "unknown";
    case "lacksAny": return Array.isArray(v) ? verdict(!cond.value.some((x) => v.some((y) => same(x, y)))) : "unknown";
    case "containsAll": return Array.isArray(v) ? verdict(cond.value.every((x) => v.some((y) => same(x, y)))) : "unknown";
    case "startsWith": return typeof v === "string" ? verdict(v.startsWith(cond.value)) : "unknown";
    case "endsWith": return typeof v === "string" ? verdict(v.endsWith(cond.value)) : "unknown";
    default: return "unknown";
  }
}

const all = (record, conditions) => {
  const results = conditions.map((c) => evalCondition(record, c));
  return results.includes("fail") ? "fail" : results.includes("unknown") ? "unknown" : "pass";
};

const shown = (v) => {
  if (v === undefined) return "(not in the model)";
  const s = Array.isArray(v) || isObject(v) ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

function evidenceFor(record, fields, result) {
  const out = {};
  for (const f of fields) out[f] = SECRET_FIELD.test(f) ? "[redacted]" : shown(valueAt(record, f));
  return { vendor: record._vendor, path: record._path, fields: out, result };
}

function evaluateOne(req, ctx) {
  const { config, vendors, attestations, asOf } = ctx;
  const base = { id: req.id, title: req.title, source: req.source, kind: req.kind };

  if (req.kind === "manual") {
    const a = attestations[req.id];
    const live = a && (!a.validUntil || a.validUntil >= asOf);
    if (live) return { ...base, verdict: "attested", reason: `attested by ${a.attestedBy} on ${a.date}, reference ${a.reference}. A human statement, not machine-checked.`, evidence: [], perVendor: {}, attestation: { attestedBy: a.attestedBy, date: a.date, reference: a.reference } };
    return { ...base, verdict: "needs_attestation", reason: a ? "the attestation has expired" : `needs a human attestation${req.evidence ? `: ${req.evidence}` : ""}`, evidence: [], perVendor: {} };
  }

  const scoped = req.scope?.vendors ?? null;
  const gaps = [];
  const records = [];
  const perVendor = {};
  const candidates = scoped ?? Object.keys(vendors).filter((v) => typeof vendors[v].provides[req.fact] === "function");

  for (const name of candidates) {
    const mapping = vendors[name];
    if (!mapping) {
      gaps.push(`no mapping for ${name}`);
      perVendor[name] = "gap";
    } else if (typeof mapping.provides[req.fact] !== "function") {
      gaps.push(`${name} does not supply ${req.fact}`);
      perVendor[name] = "gap";
    } else if (!mapping.present(config)) {
      // A vendor the requirement names but the config lacks is a gap. A vendor merely absent from the build is not.
      if (scoped) {
        gaps.push(`the config has no section for ${name}`);
        perVendor[name] = "gap";
      }
    } else {
      try {
        for (const r of mapping.provides[req.fact](config)) records.push({ ...r, _vendor: name });
        perVendor[name] ??= "none";
      } catch {
        gaps.push(`the mapping for ${name} could not read the config`);
        perVendor[name] = "gap";
      }
    }
  }

  // Nobody who could answer is in this config. That is a gap in coverage, not a failure of the requirement.
  const canAnswer = candidates.filter((n) => vendors[n] && typeof vendors[n].provides[req.fact] === "function" && vendors[n].present(config));
  if (canAnswer.length === 0 && gaps.length === 0) {
    gaps.push(candidates.length === 0 ? `no vendor mapping supplies ${req.fact}` : `the config has none of: ${candidates.join(", ")}`);
  }

  const where = req.where ?? [];
  const selected = [];
  const unplaced = [];
  for (const r of records) {
    const w = where.length ? all(r, where) : "pass";
    if (w === "pass") selected.push(r);
    else if (w === "unknown") unplaced.push(r);
  }

  const fields = [...new Set([...(req.assert ?? []).map((c) => c.field), ...(req.where ?? []).map((c) => c.field), ...(req.agree ? [req.agree.field] : [])])];
  const evidence = [];
  const mark = (vendor, result) => {
    const order = { none: 0, pass: 1, unknown: 2, fail: 3 };
    if ((order[result] ?? 0) > (order[perVendor[vendor]] ?? 0)) perVendor[vendor] = result;
  };

  let failed = 0;
  let unknown = unplaced.length;
  for (const r of unplaced) {
    evidence.push(evidenceFor(r, fields, "unknown"));
    mark(r._vendor, "unknown");
  }
  let reason = null;

  if (req.agree) {
    const values = selected.map((r) => valueAt(r, req.agree.field));
    const missing = selected.filter((_, i) => !known(values[i]));
    if (selected.length < 2) {
      unknown += 1;
      reason = "needs at least two records to compare";
      for (const r of selected) evidence.push(evidenceFor(r, fields, "unknown"));
    } else if (missing.length) {
      unknown += missing.length;
      for (const r of selected) evidence.push(evidenceFor(r, fields, known(valueAt(r, req.agree.field)) ? "pass" : "unknown"));
      for (const r of missing) mark(r._vendor, "unknown");
    } else if (new Set(values.map((v) => stableStringify(v))).size > 1) {
      failed += selected.length;
      for (const r of selected) {
        evidence.push(evidenceFor(r, fields, "fail"));
        mark(r._vendor, "fail");
      }
      reason = `the records disagree on ${req.agree.field}`;
    } else {
      for (const r of selected) {
        evidence.push(evidenceFor(r, fields, "pass"));
        mark(r._vendor, "pass");
      }
    }
  } else {
    for (const r of selected) {
      const result = all(r, req.assert);
      evidence.push(evidenceFor(r, fields, result));
      mark(r._vendor, result);
      if (result === "fail") failed += 1;
      else if (result === "unknown") unknown += 1;
    }
  }

  const minimum = req.minimum ?? 1;
  const counted = selected.length + unplaced.length;
  let verdict;
  if (failed > 0) verdict = "unmet";
  else if (counted < minimum && gaps.length === 0 && unknown === 0) {
    verdict = "unmet";
    reason = `found ${counted} matching records, and ${minimum} are needed`;
  } else if (unknown > 0 || gaps.length > 0 || counted < minimum) {
    verdict = "indeterminable";
  } else verdict = "met";

  if (verdict === "unmet" && !reason) reason = `${failed} of ${selected.length} records violate it`;
  if (verdict === "indeterminable" && !reason) {
    const parts = [];
    if (gaps.length) parts.push(gaps.join("; "));
    if (unknown) parts.push(`${unknown} record${unknown === 1 ? "" : "s"} lack a field the model does not carry`);
    if (counted < minimum && !gaps.length && !unknown) parts.push(`found ${counted} records and ${minimum} are needed`);
    if (records.length === 0 && gaps.length === 0) parts.push(`no vendor in this config supplies ${req.fact}`);
    reason = parts.join("; ");
  }
  return { ...base, verdict, reason: reason ?? "every record considered passed", evidence: evidence.slice(0, 20), evidenceTotal: evidence.length, perVendor, gaps };
}

/** Evaluates every requirement. Pure. Throws on invalid input, because a claim must not rest on a malformed requirement. */
export function evaluate({ requirements, config, attestations = {}, vendors = DEFAULT_VENDORS, asOf }) {
  const date = asOf ?? (typeof config.referenceDate === "string" ? config.referenceDate : undefined);
  if (!date || !DATE.test(date)) throw new Error("an as-of date is required: pass asOf or set referenceDate in the config");
  const problems = [...validateRequirements(requirements), ...validateAttestations(attestations, requirements, date)];
  if (problems.length > 0) throw new Error(`invalid input: ${problems.join("; ")}`);
  const ctx = { config, vendors, attestations, asOf: date };
  const results = requirements.requirements.map((r) => evaluateOne(r, ctx));
  const counts = { met: 0, unmet: 0, indeterminable: 0, attested: 0, needs_attestation: 0, total: results.length };
  for (const r of results) counts[r.verdict] += 1;
  const present = Object.keys(vendors).filter((v) => vendors[v].present(config)).sort();
  return {
    results,
    claim: {
      // Synthetic only if both inputs are. A real configuration makes the claim real, whatever the requirements say.
      requirementSetId: requirements.requirementSetId, synthetic: requirements.synthetic === true && String(config.twinId ?? "").startsWith("SYNTH-"), asOf: date,
      configDigest: sha(config), requirementsDigest: sha(requirements), attestationsDigest: sha(attestations),
      counts, vendorsPresent: present, vendorsWithMapping: Object.keys(vendors).sort()
    }
  };
}

const esc = (v) => String(v).replace(/[\r\n\t]+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SYMBOL = { pass: "ok", fail: "FAIL", unknown: "?", gap: "gap", none: "-" };
const LABEL = { met: "Met", unmet: "Unmet", indeterminable: "Indeterminable", attested: "Attested", needs_attestation: "Needs attestation" };

export function renderReport({ results, claim }) {
  const vendorColumns = [...new Set([...claim.vendorsPresent, ...results.flatMap((r) => Object.keys(r.perVendor))])].sort();
  const c = claim.counts;
  const out = [];
  out.push("# As-built requirements claim");
  out.push("");
  out.push(`Requirement set \`${esc(claim.requirementSetId)}\`, as of ${claim.asOf}. ${claim.synthetic ? "**Synthetic requirements and configuration.** They show the mechanics and are not a customer's build." : "Real customer data. Keep this report out of the repository."}`);
  out.push("");
  out.push("## What this report claims");
  out.push("");
  const are = (n) => (n === 1 ? "is" : "are");
  out.push(`Of ${c.total} requirements, **${c.met} ${are(c.met)} met** by machine check against the modeled configuration, **${c.unmet} ${are(c.unmet)} unmet**, and **${c.indeterminable} indeterminable** from the model. ${c.attested} ${are(c.attested)} attested by a person and ${c.needs_attestation} still ${c.needs_attestation === 1 ? "needs" : "need"} an attestation.`);
  out.push("");
  out.push("It speaks only for the configuration with the digests below. It does not say the real devices match that configuration, and it is not evidence about runtime behavior. A requirement marked \"Indeterminable\" is neither a pass nor a failure, and the reason says what is missing. An attestation is a person's statement and is never counted as a machine check.");
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Configuration digest | \`${claim.configDigest}\` |`);
  out.push(`| Requirements digest | \`${claim.requirementsDigest}\` |`);
  out.push(`| Attestations digest | \`${claim.attestationsDigest}\` |`);
  out.push(`| Vendors in the configuration | ${claim.vendorsPresent.join(", ") || "none"} |`);
  out.push(`| Vendors with a mapping | ${claim.vendorsWithMapping.join(", ")} |`);
  out.push("");
  out.push("## Traceability");
  out.push("");
  out.push(`| Requirement | Title | Source | Verdict | ${vendorColumns.join(" | ")} |`);
  out.push(`|---|---|---|---|${vendorColumns.map(() => "---").join("|")}|`);
  for (const r of results) out.push(`| ${esc(r.id)} | ${esc(r.title)} | ${esc(r.source)} | ${LABEL[r.verdict]} | ${vendorColumns.map((v) => SYMBOL[r.perVendor[v]] ?? "-").join(" | ")} |`);
  out.push("");
  out.push("Vendor columns: ok means every record from that vendor passed, FAIL that one did not, ? that a record lacks a field the model does not carry, gap that the vendor is named but cannot be checked, and - that the vendor has nothing to say.");
  const detail = results.filter((r) => ["unmet", "indeterminable", "needs_attestation"].includes(r.verdict));
  if (detail.length) {
    out.push("");
    out.push("## Where the claim stops, and why");
    for (const r of detail) {
      out.push("");
      out.push(`### ${esc(r.id)}: ${LABEL[r.verdict]}`);
      out.push("");
      out.push(`${esc(r.title)}. ${esc(r.reason)}.`);
      for (const e of r.evidence.filter((x) => x.result !== "pass")) out.push(`- ${e.result === "fail" ? "Violates" : "Unknown"}: \`${esc(e.path)}\` (${esc(e.vendor)}): ${Object.entries(e.fields).map(([k, v]) => `${esc(k)} = ${esc(v)}`).join(", ")}`);
    }
  }
  const done = results.filter((r) => r.verdict === "met");
  if (done.length) {
    out.push("");
    out.push("## Evidence for requirements that are met");
    for (const r of done) {
      out.push("");
      out.push(`**${esc(r.id)}** ${esc(r.title)}`);
      for (const e of r.evidence) out.push(`- \`${esc(e.path)}\` (${esc(e.vendor)}): ${Object.entries(e.fields).map(([k, v]) => `${esc(k)} = ${esc(v)}`).join(", ")}`);
    }
  }
  const attested = results.filter((r) => r.verdict === "attested");
  if (attested.length) {
    out.push("");
    out.push("## Attested by a person");
    out.push("");
    for (const r of attested) out.push(`- **${esc(r.id)}** ${esc(r.title)}. ${esc(r.reason)}`);
  }
  return `${out.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function main(argv) {
  const flag = (name) => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const requirementsPath = flag("--requirements") ?? DEFAULT_REQUIREMENTS;
  const configPath = flag("--config") ?? DEFAULT_CONFIG;
  const attestationsPath = flag("--attestations") ?? (flag("--requirements") ? undefined : DEFAULT_ATTESTATIONS);
  let requirements;
  let config;
  let attestations = {};
  try {
    requirements = await readJson(requirementsPath);
    config = await readJson(configPath);
    if (attestationsPath) attestations = await readJson(attestationsPath);
  } catch {
    console.error("could not read an input file as JSON");
    return 2;
  }
  // Real customer data stays out of the repository: it is accepted only from *.client.json files, never written out.
  const real = requirements?.synthetic !== true || !String(config?.twinId ?? "").startsWith("SYNTH-");
  if (real) {
    const files = [requirementsPath, configPath, ...(attestationsPath ? [attestationsPath] : [])];
    if (files.some((f) => !basename(f).endsWith(".client.json"))) {
      console.error("real customer data must be in files named *.client.json, which git ignores");
      return 2;
    }
    if (flag("--out")) {
      console.error("refusing to write a report file for real customer data; print it instead");
      return 2;
    }
  }
  let result;
  try {
    result = evaluate({ requirements, config, attestations });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else if (flag("--out")) {
    await writeFile(flag("--out"), renderReport(result));
    console.log(`wrote ${flag("--out")}`);
  } else console.log(renderReport(result));
  const failOn = flag("--fail-on");
  if (failOn === "unmet" && result.claim.counts.unmet > 0) return 1;
  if (failOn === "not_claimed" && (result.claim.counts.unmet + result.claim.counts.indeterminable + result.claim.counts.needs_attestation) > 0) return 1;
  return 0;
}

export { factsOf };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
