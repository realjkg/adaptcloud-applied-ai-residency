/**
 * Deterministic checker for the synthetic digital-twin network lab.
 * No vendor API, name resolution, or credential access. Input is untrusted; findings never echo values.
 */

export const TWIN_VENDORS = ["cisco-meraki", "cloudflare", "paloalto", "f5", "synthetic-app"] as const;
export type TwinVendor = (typeof TWIN_VENDORS)[number];

/** Each lab role has exactly one correct vendor. A mislabeled device is a finding, not a style note. */
export const REQUIRED_ROLES: Readonly<Record<string, TwinVendor>> = {
  "edge-waf-dns": "cloudflare",
  ngfw: "paloalto",
  "adc-ltm": "f5",
  "application-pool": "synthetic-app",
  "branch-security-appliance": "cisco-meraki",
  "management-plane": "paloalto"
};

/** RFC 5737 documentation ranges and RFC 1918 private ranges. Anything else is refused as a possible real address. */
const ALLOWED_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.2.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24]
];

const SECRET_KEY = /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i;

export const TWIN_FINDING_IDS = [
  "TWIN-SHAPE",
  "TWIN-SYNTHETIC",
  "TWIN-UNIQUE",
  "TWIN-VENDOR",
  "TWIN-ROLE",
  "TWIN-ADDR",
  "TWIN-REF",
  "TWIN-PATH",
  "TWIN-TLS",
  "TWIN-MGMT",
  "TWIN-SECRET"
] as const;
export type TwinFindingId = (typeof TWIN_FINDING_IDS)[number];

export interface TwinFinding {
  id: TwinFindingId;
  subject: string;
  message: string;
}

export interface TwinCheckResult {
  twinId: string | null;
  status: "ready_for_human_review" | "blocked";
  humanApprovalRequired: true;
  counts: { components: number; flows: number };
  findings: TwinFinding[];
}

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIPv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isAllowedLabAddress(address: string): boolean {
  const value = parseIPv4(address);
  if (value === null) return false;
  return ALLOWED_CIDRS.some(([network, prefix]) => {
    const base = parseIPv4(network);
    if (base === null) return false;
    const size = 2 ** (32 - prefix);
    return Math.floor(value / size) === Math.floor(base / size);
  });
}

/** Walks every key, so a secret nested anywhere in the spec is found. Values are never copied out. */
function secretKeyPaths(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretKeyPaths(item, `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) out.push(childPath);
    secretKeyPaths(child, childPath, out);
  }
}

export function checkDigitalTwin(input: unknown): TwinCheckResult {
  const findings: TwinFinding[] = [];
  const add = (id: TwinFindingId, subject: string, message: string) => findings.push({ id, subject, message });

  if (!isRecord(input)) {
    add("TWIN-SHAPE", "spec", "The twin specification must be a JSON object.");
    return finish(null, 0, 0, findings);
  }

  const twinId = typeof input.twinId === "string" ? input.twinId : null;
  if (input.synthetic !== true) {
    add("TWIN-SYNTHETIC", "spec", "The twin must declare synthetic: true. Real topology data is out of scope for this lab.");
  }

  const components = Array.isArray(input.components) ? input.components : null;
  const flows = Array.isArray(input.flows) ? input.flows : null;
  if (!components || !flows) {
    add("TWIN-SHAPE", "spec", "The twin must contain components and flows arrays.");
    return finish(twinId, components?.length ?? 0, flows?.length ?? 0, findings);
  }

  // Shape checks: malformed entries are reported by position, never by value.
  const nodes: Loose[] = [];
  components.forEach((item, index) => {
    const ok = isRecord(item)
      && typeof item.id === "string"
      && typeof item.vendor === "string"
      && typeof item.role === "string"
      && typeof item.zone === "string"
      && typeof item.address === "string"
      && (item.managementExposed === undefined || typeof item.managementExposed === "boolean");
    if (!ok || !isRecord(item)) add("TWIN-SHAPE", `components[${index}]`, "Component needs string id, vendor, role, zone, and address fields.");
    else nodes.push(item);
  });
  const edges: Loose[] = [];
  flows.forEach((item, index) => {
    const ok = isRecord(item)
      && typeof item.id === "string"
      && typeof item.source === "string"
      && Array.isArray(item.path)
      && item.path.every((hop) => typeof hop === "string")
      && typeof item.port === "number";
    if (!ok || !isRecord(item)) add("TWIN-SHAPE", `flows[${index}]`, "Flow needs string id, source, a string path array, and a numeric port.");
    else edges.push(item);
  });

  // Unique identifiers.
  const seenComponents = new Set<string>();
  for (const node of nodes) {
    const id = String(node.id);
    if (seenComponents.has(id)) add("TWIN-UNIQUE", id, "Component identifiers must be unique.");
    seenComponents.add(id);
  }
  const seenFlows = new Set<string>();
  for (const edge of edges) {
    const id = String(edge.id);
    if (seenFlows.has(id)) add("TWIN-UNIQUE", id, "Flow identifiers must be unique.");
    seenFlows.add(id);
  }

  const byId = new Map<string, Loose>();
  for (const node of nodes) byId.set(String(node.id), node);

  // Vendor allowlist and role-to-vendor binding.
  const roleCounts = new Map<string, number>();
  for (const node of nodes) {
    const id = String(node.id);
    const vendor = String(node.vendor);
    const role = String(node.role);
    if (!(TWIN_VENDORS as readonly string[]).includes(vendor)) {
      add("TWIN-VENDOR", id, "Vendor is not in the lab allowlist.");
    }
    if (!(role in REQUIRED_ROLES)) {
      add("TWIN-ROLE", id, "Role is not one of the lab's defined roles.");
    } else {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      if (REQUIRED_ROLES[role] !== vendor) {
        add("TWIN-ROLE", id, `Role ${role} must be implemented by ${REQUIRED_ROLES[role]}, not ${vendor}.`);
      }
    }
  }
  for (const role of Object.keys(REQUIRED_ROLES)) {
    const count = roleCounts.get(role) ?? 0;
    if (count !== 1) add("TWIN-ROLE", role, `Exactly one component must carry role ${role}; found ${count}.`);
  }

  // Addresses: only documentation and private ranges, so no real address can enter the lab.
  for (const node of nodes) {
    for (const field of ["address", "wanAddress"] as const) {
      const value = node[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isAllowedLabAddress(value)) {
        add("TWIN-ADDR", `${String(node.id)}.${field}`, "Address must use an RFC 5737 documentation or RFC 1918 private range.");
      }
    }
    if (Array.isArray(node.members)) {
      node.members.forEach((member, index) => {
        if (typeof member !== "string" || !isAllowedLabAddress(member)) {
          add("TWIN-ADDR", `${String(node.id)}.members[${index}]`, "Pool member must use an RFC 1918 or RFC 5737 address.");
        }
      });
    }
  }

  // Management plane: never exposed, and never reachable from the internet.
  for (const node of nodes) {
    if (node.managementExposed === true) {
      add("TWIN-MGMT", String(node.id), "Management interfaces must not be exposed.");
    }
  }

  // Flow checks: references, path ordering, TLS placement, and management reachability.
  for (const edge of edges) {
    const flowId = String(edge.id);
    const path = edge.path as string[];
    const missing = path.filter((hop) => !byId.has(hop));
    if (missing.length > 0) {
      add("TWIN-REF", flowId, "Flow path references a component that is not declared.");
      continue;
    }
    const roles = path.map((hop) => String(byId.get(hop)?.role));
    const indexOfRole = (role: string) => roles.indexOf(role);
    const appIndex = indexOfRole("application-pool");
    const ngfwIndex = indexOfRole("ngfw");
    const adcIndex = indexOfRole("adc-ltm");
    const edgeIndex = indexOfRole("edge-waf-dns");
    const source = String(edge.source);

    const ordered = appIndex === path.length - 1 && ngfwIndex >= 0 && adcIndex > ngfwIndex && appIndex > adcIndex
      && (source !== "internet" || (edgeIndex >= 0 && ngfwIndex > edgeIndex));
    if (!ordered) {
      add("TWIN-PATH", flowId, "Flow must cross the NGFW, then F5 delivery, then end at the application pool; internet flows must also start at the Cloudflare edge.");
    }

    if (edge.port === 443) {
      const termination = edge.tlsTermination;
      const terminationIndex = typeof termination === "string" ? path.indexOf(termination) : -1;
      if (terminationIndex < 0 || terminationIndex >= appIndex) {
        add("TWIN-TLS", flowId, "HTTPS flow must name a TLS termination point on its path, before the application pool.");
      }
    }

    if (source === "internet") {
      for (const hop of path) {
        if (byId.get(hop)?.zone === "management") {
          add("TWIN-MGMT", flowId, "An internet-sourced flow must not traverse the management zone.");
        }
      }
    }
  }

  // Secrets: report the key path only.
  const secretPaths: string[] = [];
  secretKeyPaths(input, "", secretPaths);
  for (const keyPath of secretPaths) {
    add("TWIN-SECRET", keyPath, "Secret-named field found in a twin specification. Remove it; credentials never belong in the model.");
  }

  return finish(twinId, nodes.length, edges.length, findings);
}

function finish(twinId: string | null, components: number, flows: number, findings: TwinFinding[]): TwinCheckResult {
  return {
    twinId,
    status: findings.length === 0 ? "ready_for_human_review" : "blocked",
    humanApprovalRequired: true,
    counts: { components, flows },
    findings
  };
}

type Mutation = (twin: Loose) => void;

function componentById(twin: Loose, id: string): Loose {
  const found = (twin.components as Loose[]).find((node) => node.id === id);
  if (!found) throw new Error(`fault catalog expected component ${id}`);
  return found;
}

function flowById(twin: Loose, id: string): Loose {
  const found = (twin.flows as Loose[]).find((edge) => edge.id === id);
  if (!found) throw new Error(`fault catalog expected flow ${id}`);
  return found;
}

export interface TwinFault {
  id: string;
  description: string;
  expectedFinding: TwinFindingId;
  mutate: Mutation;
}

/**
 * Deliberate faults for the lab. Each one is a realistic modeling or change-control mistake, and each
 * must be caught by exactly the finding listed. The guide in docs/DIGITAL_TWIN_NETWORK_LAB.md
 * describes them; the test suite proves the checker still detects them.
 */
export const TWIN_FAULTS: readonly TwinFault[] = [
  {
    id: "F1-bypass-ngfw",
    description: "A change moves the internet flow straight from the Cloudflare edge to F5, skipping the Palo Alto NGFW.",
    expectedFinding: "TWIN-PATH",
    mutate: (twin) => {
      flowById(twin, "app-https-inbound").path = ["cf-edge-waf", "f5-bigip-adc", "app-web-pool"];
    }
  },
  {
    id: "F2-exposed-management",
    description: "A troubleshooting change exposes the Panorama management interface.",
    expectedFinding: "TWIN-MGMT",
    mutate: (twin) => {
      componentById(twin, "panorama-mgmt").managementExposed = true;
    }
  },
  {
    id: "F3-management-on-internet-path",
    description: "A jump rule routes an internet-sourced flow through the management-zone Panorama host.",
    expectedFinding: "TWIN-MGMT",
    mutate: (twin) => {
      flowById(twin, "app-https-inbound").path = ["cf-edge-waf", "panorama-mgmt", "pa-ngfw-dmz", "f5-bigip-adc", "app-web-pool"];
    }
  },
  {
    id: "F4-pasted-credential",
    description: "An engineer pastes an API key into the F5 component record while building the model.",
    expectedFinding: "TWIN-SECRET",
    mutate: (twin) => {
      componentById(twin, "f5-bigip-adc").apiKey = "SYNTH-NOT-A-REAL-KEY";
    }
  },
  {
    id: "F5-routable-address",
    description: "A copied production address replaces the documentation address on the Cloudflare edge record.",
    expectedFinding: "TWIN-ADDR",
    mutate: (twin) => {
      componentById(twin, "cf-edge-waf").address = "8.8.8.8";
    }
  },
  {
    id: "F6-mislabeled-vendor",
    description: "The NGFW record is labeled as an F5 device, so the model no longer matches the procurement record.",
    expectedFinding: "TWIN-ROLE",
    mutate: (twin) => {
      componentById(twin, "pa-ngfw-dmz").vendor = "f5";
    }
  },
  {
    id: "F7-tls-off-path",
    description: "The HTTPS termination point names a device that is not on the branch flow's path.",
    expectedFinding: "TWIN-TLS",
    mutate: (twin) => {
      flowById(twin, "branch-to-app").tlsTermination = "cf-edge-waf";
    }
  }
];

/** Returns a deep copy of a baseline spec with one fault applied. The baseline is never modified. */
export function applyTwinFault(baseline: unknown, faultId: string): unknown {
  const fault = TWIN_FAULTS.find((candidate) => candidate.id === faultId);
  if (!fault) throw new Error(`unknown twin fault: ${faultId}`);
  const copy = structuredClone(baseline) as Loose;
  fault.mutate(copy);
  return copy;
}
