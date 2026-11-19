#!/usr/bin/env node
// Renders the twin config as a Mermaid topology.
// Only sections present in the config are drawn, so the diagram grows as the twin is built.
// Edges come from the NGFW rules, NAT, and tunnel in the config, so a config change changes the picture.
// Config text is untrusted: every label is reduced to a conservative character set before drawing.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = join(HERE, "..", "config", "twin-config.json");

/** Keeps letters, digits, and a few separators. Anything else becomes "?" so it cannot alter the diagram syntax. */
export const safe = (value, max = 48) => String(value ?? "").replace(/[^A-Za-z0-9 ._:/+,=()@-]/g, "?").slice(0, max);
const nodeId = (prefix, name) => `${prefix}_${String(name).replace(/[^A-Za-z0-9]/g, "_")}`;
const lines = (...parts) => parts.filter((part) => part !== undefined && part !== "").join("<br/>");

export function buildGraph(config) {
  const nodes = [];
  const edges = [];
  const groups = [];
  const group = (id, title) => {
    const entry = { id, title, nodeIds: [] };
    groups.push(entry);
    return entry;
  };
  const node = (entry, id, label) => {
    nodes.push({ id, label });
    entry.nodeIds.push(id);
    return id;
  };
  const edge = (from, to, label, kind = "solid", danger = false) => edges.push({ from, to, label, kind, danger });

  const pa = config.paloalto;
  const zones = Array.isArray(pa?.zones) ? pa.zones : [];
  const interfaces = Array.isArray(pa?.interfaces) ? pa.interfaces : [];
  const rules = Array.isArray(pa?.rules) ? pa.rules : [];
  const nat = Array.isArray(pa?.nat) ? pa.nat : [];
  const zoneId = (zone) => nodeId("z", zone);

  // Edge: Cloudflare
  const cf = config.cloudflare;
  let userId;
  let cfId;
  if (cf?.dns) {
    const edgeGroup = group("internet", "Internet and edge");
    userId = node(edgeGroup, "user", lines("Users", "HTTPS 443"));
    const waf = cf.waf?.managedRuleset ? `WAF ${safe(cf.waf.action)}` : undefined;
    cfId = node(edgeGroup, "cf", lines("Cloudflare edge", safe(cf.dns.name), cf.dns.proxied ? "proxied" : "not proxied", cf.ssl?.mode ? `SSL ${safe(cf.ssl.mode)}` : undefined, waf));
    edge(userId, cfId, "HTTPS 443");
  }

  // Perimeter: one node per zone, with its interfaces
  if (zones.length > 0) {
    const ngfwTitle = rules.length > 0 && rules.at(-1)?.action === "deny" && rules.at(-1)?.source === "any" ? "Palo Alto NGFW (default deny last)" : "Palo Alto NGFW";
    const ngfw = group("ngfw", ngfwTitle);
    for (const zone of zones) {
      const members = interfaces.filter((item) => item.zone === zone).map((item) => `${safe(item.name, 16)} ${safe(item.address, 20)}`);
      node(ngfw, zoneId(zone), lines(`zone ${safe(zone, 20)}`, ...members));
    }
  }
  const hasZone = (zone) => zones.includes(zone);

  if (cfId && hasZone("untrust")) edge(cfId, zoneId("untrust"), `origin ${safe(cf.dns.content, 20)}`);

  // Delivery: F5 virtual server, pool, members
  const f5 = config.f5;
  if (f5?.virtualServer || f5?.pool) {
    const dc = group("dc", "Data center");
    let vipId;
    let poolId;
    if (f5.virtualServer) {
      const tls = f5.clientSsl?.minVersion ? safe(f5.clientSsl.minVersion) : undefined;
      vipId = node(dc, "vip", lines("F5 virtual server", safe(f5.virtualServer.destination), tls, f5.virtualServer.snat ? `SNAT ${safe(f5.virtualServer.snat)}` : undefined));
      if (hasZone("dmz")) edge(zoneId("dmz"), vipId, "dmz", "line");
    }
    if (f5.pool) {
      poolId = node(dc, "pool", lines(`Pool ${safe(f5.pool.name)}`, f5.pool.monitor?.type ? `${safe(f5.pool.monitor.type)} monitor` : "no monitor"));
      if (vipId) edge(vipId, poolId, "default pool");
      for (const member of Array.isArray(f5.pool.members) ? f5.pool.members : []) {
        const id = node(dc, nodeId("m", member.address), lines("Member", `${safe(member.address, 20)}:${safe(member.port, 6)}`));
        edge(poolId, id, "");
        if (hasZone("app")) edge(zoneId("app"), id, "app", "line");
      }
    }
  }

  // Management
  if (config.management && config.addressing?.panorama) {
    const mgmt = group("mgmt", "Management");
    const panorama = node(mgmt, "panorama", lines("Panorama", safe(config.addressing.panorama, 20)));
    if (hasZone("management")) {
      const services = Array.isArray(config.management.protocols) ? config.management.protocols.map((item) => safe(item, 8)).join(" ") : "";
      edge(panorama, zoneId("management"), `manages ${services}`.trim(), "dotted");
    }
  }

  // Branch
  const peer = config.meraki?.nonMerakiPeer;
  if (peer) {
    const branch = group("branch", "Branch");
    const lan = node(branch, "lan", lines("Branch clients", safe(peer.localNetworks?.[0], 20)));
    const mx = node(branch, "mx", lines("Meraki MX", `WAN ${safe(config.addressing?.branchWan, 20)}`));
    edge(lan, mx, "");
    if (hasZone("vpn-branch")) edge(mx, zoneId("vpn-branch"), `IPsec IKEv${safe(peer.ikeVersion, 2)} to ${safe(peer.publicIp, 20)}`, "thick");
  }

  // Policy: every allow rule between known zones becomes a labeled edge. A path into app from outside dmz is flagged.
  for (const rule of rules) {
    if (rule.action !== "allow" || !hasZone(rule.from) || !hasZone(rule.to)) continue;
    const natEntry = nat.find((entry) => typeof entry.original === "string" && entry.original.startsWith(`${rule.destination}:`));
    const label = lines(safe(rule.name, 24), safe(rule.service, 12), natEntry ? `NAT to ${safe(natEntry.translated, 22)}` : undefined);
    edge(zoneId(rule.from), zoneId(rule.to), label, "solid", rule.to === "app" && rule.from !== "dmz");
  }

  if (nodes.length === 0) {
    const empty = group("empty", "Twin");
    node(empty, "empty", "No sections built yet");
  }
  return { nodes, edges, groups };
}

const ARROW = { solid: ["-->", "-->"], dotted: ["-.->", "-.->"], thick: ["==>", "==>"], line: ["---", "---"] };

export function toMermaid(graph) {
  const out = ["flowchart LR"];
  const byId = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  for (const entry of graph.groups) {
    out.push(`  subgraph ${entry.id}["${safe(entry.title, 40)}"]`);
    for (const id of entry.nodeIds) out.push(`    ${id}["${byId.get(id).label}"]`);
    out.push("  end");
  }
  const dangerous = [];
  graph.edges.forEach((item, index) => {
    const arrow = ARROW[item.kind][0];
    out.push(item.label ? `  ${item.from} ${arrow}|"${item.label}"| ${item.to}` : `  ${item.from} ${arrow} ${item.to}`);
    if (item.danger) dangerous.push(index);
  });
  if (dangerous.length > 0) out.push(`  linkStyle ${dangerous.join(",")} stroke:#d33,stroke-width:3px`);
  return out.join("\n");
}

export const renderMermaid = (config) => toMermaid(buildGraph(config));

export function renderMarkdown(config) {
  return `# Topology

Generated from \`config/twin-config.json\` by \`npm run topology\`. Do not edit by hand.

\`\`\`mermaid
${renderMermaid(config)}
\`\`\`

## Reading the diagram

- Boxes inside the NGFW are zones. Each arrow between zones is an allow rule, labeled with the rule name, service, and any NAT. Anything not drawn is denied by the default rule.
- A thin line with no arrow attaches a device to its zone.
- A dotted arrow is management. A thick arrow is the IPsec tunnel.
- A red arrow is an allow rule into the app zone from anywhere except the DMZ. The F5 is meant to be the only path to the pool, so a red arrow is a finding.
`;
}

export async function main(argv) {
  const valueFor = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  let config;
  try {
    config = JSON.parse(await readFile(valueFor("--config") ?? DEFAULT_CONFIG, "utf8"));
  } catch {
    console.error("could not read the config as JSON");
    return 2;
  }
  const out = valueFor("--out");
  if (out) {
    await writeFile(out, renderMarkdown(config));
    console.log(`wrote ${out}`);
  } else {
    console.log(renderMermaid(config));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
