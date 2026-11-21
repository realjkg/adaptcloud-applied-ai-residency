// In-memory stand-in for a vendor tenant. It makes the real asymmetries between create and delete visible:
// unmanaged objects that must never be touched, deletes that are refused while something still uses the object,
// writes that read back wrong, and writes that fail halfway through a run.
// It holds no credentials and opens no connection.

const keyOf = ({ vendor, object, name }) => `${vendor}/${object}/${name}`;
const clone = (value) => structuredClone(value);

/** Keys of the objects this entry depends on. Deleting any of them while this entry exists must be refused. */
export function refsOf(entry) {
  const { vendor, object, name, attributes: a = {} } = entry;
  const ref = (kind, target) => (typeof target === "string" && target !== "any" ? [`${vendor}/${kind}/${target}`] : []);
  switch (object) {
    case "virtual-server": return [...ref("pool", a.pool), ...ref("client-ssl-profile", a.clientSslProfile)];
    case "client-ssl-profile": return ref("ssl-certificate", a.certificate);
    case "pool": return ref("monitor", `${name}-monitor`);
    case "pool-member": return ref("pool", a.pool);
    case "security-rule": return [...ref("zone", a.from), ...ref("zone", a.to), ...ref("address-object", a.source)];
    case "nat-rule": return ref("zone", a.from);
    case "interface": return ref("zone", a.zone);
    case "ipsec-tunnel": return ref("interface", name);
    case "static-route": return ref("interface", a.nextHop);
    default: return [];
  }
}

export class LabTransport {
  kind = "simulator";

  /**
   * @param {object} options
   * @param {object[]} [options.entries] existing state, as returned by snapshot()
   * @param {string[]} [options.failOn] keys whose create throws, to test partial failure
   * @param {string[]} [options.corruptOn] keys that are stored with different attributes, to test read-back verification
   */
  constructor({ entries = [], failOn = [], corruptOn = [] } = {}) {
    this.state = new Map(entries.map((entry) => [keyOf(entry), clone(entry)]));
    this.failOn = new Set(failOn);
    this.corruptOn = new Set(corruptOn);
  }

  /** Adds an object that this twin does not own. Destroy must never delete it. */
  seedUnmanaged(key, attributes = {}) {
    this.state.set(keyOf(key), { ...key, attributes: clone(attributes), managedBy: null });
  }

  async read(key) {
    const entry = this.state.get(keyOf(key));
    return entry ? clone(entry) : null;
  }

  async create(key, attributes, managedBy) {
    const id = keyOf(key);
    if (this.failOn.has(id)) throw new Error("injected failure");
    if (this.state.has(id)) throw new Error("object already exists");
    const stored = this.corruptOn.has(id) ? { ...clone(attributes), corrupted: true } : clone(attributes);
    this.state.set(id, { ...key, attributes: stored, managedBy });
  }

  async delete(key, managedBy) {
    const id = keyOf(key);
    const entry = this.state.get(id);
    if (!entry) return { ok: true, outcome: "not_found" };
    if (entry.managedBy !== managedBy) return { ok: false, reason: "unmanaged_object" };
    for (const other of this.state.values()) {
      if (keyOf(other) !== id && refsOf(other).includes(id)) return { ok: false, reason: "in_use" };
    }
    this.state.delete(id);
    return { ok: true, outcome: "deleted" };
  }

  snapshot() {
    return [...this.state.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => clone(entry));
  }
}
