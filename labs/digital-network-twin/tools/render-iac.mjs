#!/usr/bin/env node
// Plan-only infrastructure rendering from the twin config.
//
// Outputs:
//   changeset.json        ordered, provider-neutral operations for all four vendors (the "plan")
//   terraform/cloudflare  HCL for the Cloudflare edge, with a mock-provider plan test
//   terraform/f5          HCL for the F5 BIG-IP objects, with a mock-provider plan test
//
// Palo Alto and Meraki are rendered to the change set only. Their Terraform providers changed
// schema between major versions and could not be verified here.
//
// Safety: refuses to render unless every stage is healthy. Never reads or writes a credential:
// provider credentials come from the environment, keys and certificates are sensitive variables,
// and the pre-shared key stays a secret-store reference. Nothing here applies anything.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAgent } from "./health-agent.mjs";
import { loadStages } from "./twin-sequence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = join(HERE, "..", "config", "twin-config.json");
export const DEFAULT_OUT = join(HERE, "..", "rendered");

/** Fail closed: IaC is generated only from a config that passes every health check. */
export function assertHealthy(config) {
  const report = runAgent({ stages: loadStages(), config });
  if (report.status !== "healthy") {
    const { stage, failing, reason } = report.halted;
    throw new Error(`refusing to render: stage ${stage} is unhealthy (${failing.join(", ") || reason})`);
  }
}

/** HCL string literal. `${` and `%{` are escaped so config text can never become an interpolation. */
const hcl = (value) => {
  // Replacer functions are used because "$$" in a replacement string means a single "$".
  if (typeof value === "string") return JSON.stringify(value).replaceAll("${", () => "$${").replaceAll("%{", () => "%%{");
  if (Array.isArray(value)) return `[${value.map(hcl).join(", ")}]`;
  return String(value);
};

function block(type, labels, attrs) {
  const width = Math.max(...attrs.map(([key]) => key.length));
  const body = attrs.map(([key, value]) => `  ${key.padEnd(width)} = ${value}`).join("\n");
  return `${type} ${labels.map((label) => `"${label}"`).join(" ")} {\n${body}\n}\n`;
}

const stageOf = {
  management: "02", zones: "03", interfaces: "03", routes: "03", monitor: "04", pool: "04", member: "04",
  certificate: "05", clientSsl: "06", virtualServer: "06", addressObject: "07", nat: "07", rule: "07",
  dns: "08", zoneSetting: "08", waf: "09", originPulls: "09", ipsec: "10", peer: "10", merakiRule: "11", returnRoute: "11"
};

/** Ordered, provider-neutral operations. Every operation is a create; nothing here can destroy or apply. */
export function buildChangeSet(config) {
  const ops = [];
  const add = (key, vendor, object, name, attributes) => ops.push({ stage: stageOf[key], vendor, object, name, action: "create", attributes });
  const pa = config.paloalto;
  const tunnel = pa.ipsec.tunnelInterface;

  add("management", "paloalto", "management-access", "mgt", { permittedSources: config.management.permittedSources, protocols: config.management.protocols });
  for (const zone of pa.zones) add("zones", "paloalto", "zone", zone, {});
  for (const item of pa.interfaces) add("interfaces", "paloalto", "interface", item.name, { zone: item.zone, address: item.address, ...(item.managementProfile ? { managementProfile: item.managementProfile } : {}) });
  for (const route of pa.routes.filter((item) => item.nextHop !== tunnel)) add("routes", "paloalto", "static-route", route.destination, { nextHop: route.nextHop });

  add("monitor", "f5", "monitor", `${config.f5.pool.name}-monitor`, { type: config.f5.pool.monitor.type, receive: config.f5.pool.monitor.receive });
  add("pool", "f5", "pool", config.f5.pool.name, { method: config.f5.pool.method });
  for (const member of config.f5.pool.members) add("member", "f5", "pool-member", `${member.address}:${member.port}`, { pool: config.f5.pool.name });
  const certificate = config.tls.certificate;
  add("certificate", "f5", "ssl-certificate", certificate.name, { subject: certificate.subject, notAfter: certificate.notAfter, issuer: certificate.issuer });
  add("clientSsl", "f5", "client-ssl-profile", config.f5.clientSsl.name, { certificate: config.f5.clientSsl.certificate, minVersion: config.f5.clientSsl.minVersion });
  add("virtualServer", "f5", "virtual-server", config.f5.virtualServer.name, { destination: config.f5.virtualServer.destination, pool: config.f5.virtualServer.pool, clientSslProfile: config.f5.virtualServer.clientSslProfile, snat: config.f5.virtualServer.snat });

  for (const [name, object] of Object.entries(pa.addressObjects)) add("addressObject", "paloalto", "address-object", name, { source: object.source });
  for (const nat of pa.nat) add("nat", "paloalto", "nat-rule", nat.name, { from: nat.from, original: nat.original, translated: nat.translated });
  pa.rules.forEach((rule, index) => add("rule", "paloalto", "security-rule", rule.name, { position: index + 1, from: rule.from, to: rule.to, source: rule.source, destination: rule.destination, service: rule.service, action: rule.action, log: rule.log }));

  add("dns", "cloudflare", "dns-record", config.cloudflare.dns.name, { type: config.cloudflare.dns.type, content: config.cloudflare.dns.content, proxied: config.cloudflare.dns.proxied });
  add("zoneSetting", "cloudflare", "zone-setting", "ssl", { value: config.cloudflare.ssl.mode });
  add("waf", "cloudflare", "managed-ruleset", "cloudflare-managed", { action: config.cloudflare.waf.action });
  add("originPulls", "cloudflare", "authenticated-origin-pulls", config.hostname, { enabled: config.cloudflare.authenticatedOriginPulls });

  add("ipsec", "paloalto", "ipsec-tunnel", tunnel, { ikeVersion: pa.ipsec.ikeVersion, peer: pa.ipsec.peer, pskRef: pa.ipsec.pskRef });
  const peer = config.meraki.nonMerakiPeer;
  add("peer", "meraki", "non-meraki-vpn-peer", peer.name, { publicIp: peer.publicIp, ikeVersion: peer.ikeVersion, localNetworks: peer.localNetworks, remoteNetworks: peer.remoteNetworks, pskRef: peer.pskRef });
  config.meraki.firewall.forEach((rule, index) => add("merakiRule", "meraki", "l3-firewall-rule", `rule-${index + 1}`, { position: index + 1, ...rule }));
  for (const route of pa.routes.filter((item) => item.nextHop === tunnel)) add("returnRoute", "paloalto", "static-route", route.destination, { nextHop: route.nextHop });

  return ops.sort((a, b) => a.stage.localeCompare(b.stage)).map((op, index) => ({ order: index + 1, ...op }));
}

const GENERATED = "# Rendered from the twin config by tools/render-iac.mjs. Plan-only: never apply from the lab.\n";

function cloudflareFiles(config) {
  const { dns, ssl, waf } = config.cloudflare;
  const versions = `terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# Credentials come from the CLOUDFLARE_API_TOKEN environment variable, never from this file.
provider "cloudflare" {}
`;
  const variables = `variable "zone_id" {
  type        = string
  description = "Zone that owns the application hostname."
}
`;
  const main = `${GENERATED}
${block("resource", ["cloudflare_dns_record", "app"], [
    ["zone_id", "var.zone_id"], ["name", hcl(dns.name)], ["type", hcl(dns.type)], ["content", hcl(dns.content)], ["ttl", "1"], ["proxied", hcl(dns.proxied)]
  ])}
${block("resource", ["cloudflare_zone_setting", "ssl"], [
    ["zone_id", "var.zone_id"], ["setting_id", hcl("ssl")], ["value", hcl(ssl.mode)]
  ])}
# Cloudflare Managed Ruleset, with the twin's action applied as a ruleset-level override.
resource "cloudflare_ruleset" "waf_managed" {
  zone_id = var.zone_id
  name    = "Managed WAF"
  kind    = "zone"
  phase   = "http_request_firewall_managed"

  rules = [{
    action      = "execute"
    description = "Execute the Cloudflare Managed Ruleset"
    expression  = "true"
    enabled     = true

    action_parameters = {
      id        = "efb7b8c949ac4650a09736fc376e9aee"
      overrides = { action = ${hcl(waf.action)} }
    }
  }]
}

# Authenticated Origin Pulls is not rendered: the resource differs between provider versions.
# Enable it for ${hcl(config.hostname)} and pair it with the origin certificate check in stage 09.
`;
  const test = `mock_provider "cloudflare" {}

run "plan_matches_twin" {
  command = plan

  variables {
    zone_id = "synthetic-zone-id"
  }

  assert {
    condition     = cloudflare_zone_setting.ssl.value == ${hcl(ssl.mode)}
    error_message = "SSL mode must match the twin."
  }

  assert {
    condition     = cloudflare_dns_record.app.proxied == ${hcl(dns.proxied)}
    error_message = "The record proxy setting must match the twin."
  }

  assert {
    condition     = cloudflare_dns_record.app.content == ${hcl(dns.content)}
    error_message = "The record must point at the planned origin."
  }
}
`;
  return { "versions.tf": versions, "variables.tf": variables, "main.tf": main, "tests/plan.tftest.hcl": test };
}

function f5Files(config) {
  const { pool, clientSsl, virtualServer } = config.f5;
  const [vipAddress, vipPort] = virtualServer.destination.split(":");
  const versions = `terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    bigip = {
      source  = "F5Networks/bigip"
      version = "~> 1.22"
    }
  }
}

provider "bigip" {
  address  = var.bigip_address
  username = var.bigip_username
  password = var.bigip_password
}
`;
  const variables = `variable "bigip_address" {
  type        = string
  description = "Management address of the BIG-IP."
}

variable "bigip_username" {
  type      = string
  sensitive = true
}

variable "bigip_password" {
  type      = string
  sensitive = true
}

variable "certificate_pem" {
  type        = string
  sensitive   = true
  description = "Certificate chain, supplied at run time from the secret store."
}

variable "private_key_pem" {
  type        = string
  sensitive   = true
  description = "Private key, supplied at run time from the secret store. Never committed."
}
`;
  const members = pool.members.map((member, index) => `${block("resource", ["bigip_ltm_pool_attachment", `member_${index + 1}`], [
    ["pool", "bigip_ltm_pool.app.name"], ["node", hcl(`${member.address}:${member.port}`)]
  ])}`).join("\n");
  const main = `${GENERATED}
${block("resource", ["bigip_ltm_monitor", "app"], [
    ["name", hcl(`/Common/${pool.name}-monitor`)], ["parent", hcl(`/Common/${pool.monitor.type}`)], ["send", hcl(pool.monitor.send)], ["receive", hcl(pool.monitor.receive)], ["interval", "5"], ["timeout", "16"]
  ])}
${block("resource", ["bigip_ltm_pool", "app"], [
    ["name", hcl(`/Common/${pool.name}`)], ["load_balancing_mode", hcl(pool.method)], ["monitors", "[bigip_ltm_monitor.app.name]"]
  ])}
${members}
${block("resource", ["bigip_ssl_certificate", "app"], [
    ["name", hcl(`${config.tls.certificate.name}.crt`)], ["content", "var.certificate_pem"], ["partition", hcl("Common")]
  ])}
${block("resource", ["bigip_ssl_key", "app"], [
    ["name", hcl(`${config.tls.certificate.name}.key`)], ["content", "var.private_key_pem"], ["partition", hcl("Common")]
  ])}
# The twin requires ${hcl(clientSsl.minVersion)} or later. Set the minimum through the profile's
# options for your BIG-IP version, then confirm it with the stage 06 verification.
${block("resource", ["bigip_ltm_profile_client_ssl", "app"], [
    ["name", hcl(`/Common/${clientSsl.name}`)], ["defaults_from", hcl("/Common/clientssl")], ["cert", hcl(`/Common/${config.tls.certificate.name}.crt`)], ["key", hcl(`/Common/${config.tls.certificate.name}.key`)]
  ])}
${block("resource", ["bigip_ltm_virtual_server", "app"], [
    ["name", hcl(`/Common/${virtualServer.name}`)], ["destination", hcl(vipAddress)], ["port", vipPort], ["ip_protocol", hcl(virtualServer.protocol)], ["pool", "bigip_ltm_pool.app.name"],
    ["client_profiles", "[bigip_ltm_profile_client_ssl.app.name]"], ["source_address_translation", hcl(virtualServer.snat)]
  ])}`;
  const test = `mock_provider "bigip" {}

run "plan_matches_twin" {
  command = plan

  variables {
    bigip_address   = "192.0.2.10"
    bigip_username  = "synthetic"
    bigip_password  = "synthetic"
    certificate_pem = "synthetic"
    private_key_pem = "synthetic"
  }

  assert {
    condition     = bigip_ltm_virtual_server.app.destination == ${hcl(vipAddress)}
    error_message = "The virtual server must listen on the planned VIP."
  }

  assert {
    condition     = bigip_ltm_virtual_server.app.port == ${vipPort}
    error_message = "The virtual server must listen on the planned port."
  }

  assert {
    condition     = bigip_ltm_virtual_server.app.source_address_translation == ${hcl(virtualServer.snat)}
    error_message = "SNAT must match the twin."
  }
}
`;
  return { "versions.tf": versions, "variables.tf": variables, "main.tf": main, "tests/plan.tftest.hcl": test };
}

const README = `# Rendered plan

Generated from \`config/twin-config.json\` by \`npm run render:iac\`. Do not edit by hand.

- \`changeset.json\`: ordered, provider-neutral operations for all four vendors.
- \`terraform/cloudflare\` and \`terraform/f5\`: Terraform for those two vendors, with a mock-provider plan test each.
- Palo Alto and Meraki appear in the change set only.

Plan-only. Run the tests with mock providers and do not apply. Provider schemas were not checked when this was generated, so run \`terraform init\` and \`terraform validate\` in an environment that can reach the provider registry before you rely on any resource or attribute name.
`;

/** Returns { relativePath: content } for everything the renderer produces. Throws unless the config is healthy. */
export function renderIac(config) {
  assertHealthy(config);
  const files = { "README.md": README, "changeset.json": `${JSON.stringify(buildChangeSet(config), null, 2)}\n` };
  for (const [name, content] of Object.entries(cloudflareFiles(config))) files[`terraform/cloudflare/${name}`] = content;
  for (const [name, content] of Object.entries(f5Files(config))) files[`terraform/f5/${name}`] = content;
  return files;
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
  let files;
  try {
    files = renderIac(config);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const out = valueFor("--out");
  if (!out && !argv.includes("--write")) {
    for (const path of Object.keys(files)) console.log(path);
    return 0;
  }
  const target = out ?? DEFAULT_OUT;
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content);
  }
  console.log(`wrote ${Object.keys(files).length} files to ${target}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
