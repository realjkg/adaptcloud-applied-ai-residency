import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, DEFAULT_SCENARIO, evaluate, PARAM_PATHS, PROVENANCE, recommendPrefix, renderReport, sweep, validateScenario } from "../tools/rto-wifi.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scenario = () => JSON.parse(readFileSync(DEFAULT_SCENARIO, "utf8"));
const zone = (result, name) => result.zones.find((z) => z.name === name);

test("the shipped scenario is valid and labeled synthetic", () => {
  const s = scenario();
  assert.deepEqual(validateScenario(s), []);
  assert.equal(s.synthetic, true);
});

test("the shipped demo outcome: healthy before, address pool and two zones over after, uplink on watch", () => {
  const { before, after } = compare(scenario());
  assert.equal(before.worst, "ok");
  assert.deepEqual(before.zones.map((z) => z.status), ["ok", "ok", "ok", "ok"]);
  assert.equal(before.dhcp.status, "ok");
  assert.equal(after.dhcp.status, "over");
  assert.equal(after.wan.status, "watch");
  assert.deepEqual(after.zones.map((z) => z.status), ["watch", "over", "watch", "over"]);
  assert.equal(after.worst, "over");
  assert.equal(Math.round(after.peakOnSite), 650);
});

test("it reproduces Meraki's worked example: 600 users at 3 Mbps over 101 Mbps APs is about 18 APs by throughput", () => {
  const s = scenario();
  s.population = { ...s.population, existingOnSiteStaff: 600, returningStaff: 0 };
  s.clients = { ...s.clients, activeShare: 1 };
  s.traffic.perUserMbps = 3;
  s.radio.perApThroughputMbps = 101;
  s.zones = [{ name: "Auditorium", aps: 1, share: 1 }];
  const result = evaluate(s, 1).zones[0];
  assert.equal(result.demandMbps, 1800);
  assert.equal(Math.ceil(1800 / 101), 18);
  // The client-count figure is larger than the throughput figure here, and the AP count is the larger of the two.
  assert.equal(result.apsMeraki, Math.max(18, Math.ceil(result.associated * s.clients.fiveGhzShare / 25)));
});

test("more days in the office never reduces any load or the number of APs needed", () => {
  const rows = sweep(scenario());
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].peakOnSite >= rows[i - 1].peakOnSite);
    assert.ok(rows[i].worstPer5Radio >= rows[i - 1].worstPer5Radio);
    assert.ok(rows[i].dhcpUtilization >= rows[i - 1].dhcpUtilization);
    assert.ok(rows[i].wanUtilization >= rows[i - 1].wanUtilization);
    assert.ok(rows[i].addMinimum >= rows[i - 1].addMinimum);
    assert.ok(rows[i].addWithHeadroom >= rows[i - 1].addWithHeadroom);
  }
});

test("the sweep shows where the first problem appears", () => {
  const rows = sweep(scenario());
  assert.equal(rows.length, 5);
  assert.equal(rows.find((r) => r.dhcpStatus === "over").days, 2, "the address pool breaks first");
  assert.equal(rows.find((r) => r.zonesWatch > 0).days, 3);
  assert.equal(rows.find((r) => r.zonesOver > 0).days, 4);
});

test("adding the recommended APs resolves the zone: the Meraki count clears 'over', the headroom count clears 'watch'", () => {
  const s = scenario();
  const { after } = compare(s);
  for (const z of after.zones) {
    const minimum = structuredClone(s);
    minimum.zones.find((x) => x.name === z.name).aps = z.apsMeraki;
    const withMin = zone(evaluate(minimum, 4), z.name);
    assert.notEqual(withMin.status, "over", `${z.name} with the Meraki count`);

    const headroom = structuredClone(s);
    headroom.zones.find((x) => x.name === z.name).aps = z.apsHeadroom;
    assert.equal(zone(evaluate(headroom, 4), z.name).status, "ok", `${z.name} with headroom`);
  }
});

test("the recommended subnet fits the leases under the watch level, and the next size down would not", () => {
  const { after } = compare(scenario());
  const { leased, recommendedPrefix } = after.dhcp;
  const reserved = scenario().network.reservedAddresses;
  assert.ok(leased / (2 ** (32 - recommendedPrefix) - 2 - reserved) <= 0.8);
  assert.ok(leased / (2 ** (32 - recommendedPrefix - 1) - 2 - reserved) > 0.8);
  assert.equal(recommendPrefix(10 ** 9, 0, 0.8), null);
  assert.equal(recommendPrefix(0, 0, 0.8), 30);
});

test("user impact shares add up to 100%, and a healthy site has none on an over-capacity zone", () => {
  const { before, after } = compare(scenario());
  for (const e of [before, after]) assert.ok(Math.abs(e.impact.ok + e.impact.watch + e.impact.over - 1) < 1e-9);
  assert.equal(before.impact.over, 0);
  assert.ok(after.impact.over > 0);
});

test("evaluation is deterministic and does not modify its input", () => {
  const s = scenario();
  const copy = JSON.stringify(s);
  assert.deepEqual(compare(s), compare(s));
  assert.equal(JSON.stringify(s), copy);
});

test("validation rejects out-of-range, non-numeric, and inconsistent inputs without echoing them", () => {
  const bad = (mutate) => {
    const s = scenario();
    mutate(s);
    return validateScenario(s);
  };
  const cases = [
    (s) => { s.population.returningStaff = -1; },
    (s) => { s.population.returningStaff = 1.5; },
    (s) => { s.population.returningStaff = "500"; },
    (s) => { s.population.returningStaff = Number.NaN; },
    (s) => { s.population.returningStaff = 10 ** 9; },
    (s) => { s.population.daysPerWeekAfter = 6; },
    (s) => { s.clients.fiveGhzShare = 1.5; },
    (s) => { s.radio.channelWidthMHz = 30; },
    (s) => { s.limits.targetUtilization = 0; },
    (s) => { s.network.corpVlanPrefix = 8; },
    (s) => { s.zones = []; },
    (s) => { s.zones[0].aps = 0; },
    (s) => { s.zones[0].share = 0.9; },
    (s) => { s.zones[1].name = s.zones[0].name; },
    (s) => { s.zones[0].name = "<script>"; },
    (s) => { delete s.provenance["radio.apUplinkMbps"]; },
    (s) => { s.provenance["traffic.perUserMbps"] = "trust me"; },
    (s) => { delete s.synthetic; }
  ];
  for (const mutate of cases) assert.ok(bad(mutate).length > 0, mutate.toString());
  assert.deepEqual(validateScenario(null), ["scenario must be a JSON object"]);
  const hostile = scenario();
  hostile.zones[0].name = "SENTINEL-<b>LEAK";
  assert.ok(!validateScenario(hostile).join("\n").includes("SENTINEL"));
});

test("every parameter has a provenance tag from the allowed set, and the Meraki-sourced values are the documented ones", () => {
  const s = scenario();
  for (const path of PARAM_PATHS) assert.ok(PROVENANCE.includes(s.provenance[path]), path);
  const fromMeraki = PARAM_PATHS.filter((path) => s.provenance[path] === "meraki-doc");
  assert.deepEqual(fromMeraki.sort(), ["radio.channelWidthMHz", "radio.highDensityThresholdPerAp", "radio.perApThroughputMbps", "radio.recommendedClientsPerRadio", "traffic.perUserMbps"]);
  assert.equal(s.radio.recommendedClientsPerRadio, 25);
  assert.equal(s.radio.highDensityThresholdPerAp, 30);
  assert.equal(s.radio.channelWidthMHz, 20);
});

test("the committed report is exactly what the model produces", () => {
  assert.equal(readFileSync(join(root, "docs", "RTO_WIFI_REPORT.md"), "utf8"), renderReport(scenario()));
});

test("the report says the inputs are synthetic and lists what is still a placeholder", () => {
  const report = renderReport(scenario());
  assert.match(report, /Synthetic inputs/);
  assert.match(report, /placeholder/);
  assert.match(report, /needs client data/);
  assert.match(report, /does not model coverage, interference, or roaming/);
});

function cli(args) {
  const result = spawnSync("node", [join(root, "tools", "rto-wifi.mjs"), ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("CLI: prints the report, supports JSON, and --fail-on-over returns non-zero for the shipped demo", () => {
  assert.equal(cli([]).status, 0);
  assert.match(cli([]).out, /Return-to-office Wi-Fi what-if/);
  assert.equal(JSON.parse(cli(["--json"]).out).sweep.length, 5);
  assert.equal(cli(["--fail-on-over"]).status, 1);
});

test("CLI: real client data is accepted only from a *.client.json file, and never written to disk as a report", () => {
  const dir = mkdtempSync(join(tmpdir(), "twin-rto-"));
  try {
    const real = { ...scenario(), synthetic: false };
    const plain = join(dir, "site.json");
    const client = join(dir, "acme.client.json");
    writeFileSync(plain, JSON.stringify(real));
    writeFileSync(client, JSON.stringify(real));
    assert.equal(cli([`--scenario=${plain}`]).status, 2, "a real-data file with an ordinary name is refused");
    assert.match(cli([`--scenario=${plain}`]).err, /\*\.client\.json/);
    assert.equal(cli([`--scenario=${client}`]).status, 0);
    assert.match(cli([`--scenario=${client}`]).out, /Inputs supplied for a real site/);
    assert.equal(cli([`--scenario=${client}`, `--out=${join(dir, "report.md")}`]).status, 2, "no report file is written for real data");
    assert.throws(() => readFileSync(join(dir, "report.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: an unreadable or invalid scenario fails cleanly", () => {
  assert.equal(cli(["--scenario=/nonexistent.json"]).status, 2);
  const dir = mkdtempSync(join(tmpdir(), "twin-rto-"));
  try {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ ...scenario(), zones: [] }));
    const result = cli([`--scenario=${path}`]);
    assert.equal(result.status, 2);
    assert.match(result.err, /invalid: zones/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guide's claim holds: with the shipped inputs AP throughput is never the limit, client density is", () => {
  const s = scenario();
  for (let days = 1; days <= s.population.workDaysPerWeek; days += 1) {
    for (const z of evaluate(s, days).zones) {
      assert.equal(z.checks.find((c) => c.metric === "AP throughput").status, "ok", `${z.name} at ${days} days`);
      assert.equal(z.checks.find((c) => c.metric === "AP uplink").status, "ok");
    }
  }
  const worst = evaluate(s, 5).zones.find((z) => z.status === "over");
  assert.equal(worst.checks.find((c) => c.metric === "5 GHz clients per radio").status, "over");
});

test("the guide and the report agree with the model on where the first problems appear", () => {
  const guide = readFileSync(join(root, "docs", "RTO_WIFI_SCENARIO.md"), "utf8");
  const rows = sweep(scenario());
  assert.match(guide, /address pool is over at two days/);
  assert.match(guide, /goes on watch at three/);
  assert.match(guide, /goes over at four/);
  assert.equal(rows.find((r) => r.dhcpStatus === "over").days, 2);
  assert.equal(rows.find((r) => r.zonesWatch > 0).days, 3);
  assert.equal(rows.find((r) => r.zonesOver > 0).days, 4);
});
