// Palo Alto planning: address objects and the commit scope. Pure, with no network and no credentials.

import { markFor, same } from "./common.mjs";

const NAME = /^[A-Za-z0-9._-]{1,63}$/;
const NETMASK = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const TEXT = /^[A-Za-z0-9 ._:,-]{0,200}$/;
export const CHANGE_TYPES = {
  "address-object.create": {
    label: "Create an address object (candidate edit, then a partial commit by the API administrator)",
    fields: [{ name: "name", label: "Name" }, { name: "ipNetmask", label: "IP address or CIDR" }, { name: "description", label: "Description (optional)", optional: true }],
    validate(p) {
      const bad = [];
      if (typeof p.name !== "string" || !NAME.test(p.name)) bad.push("name must be 1 to 63 letters, digits, . _ -");
      if (typeof p.ipNetmask !== "string" || !NETMASK.test(p.ipNetmask)) bad.push("ipNetmask must be an IPv4 address or CIDR");
      if (p.description !== undefined && (typeof p.description !== "string" || !TEXT.test(p.description))) bad.push("description must be plain text");
      return bad;
    },
    plan(state, p, { opId }) {
      if (state.object) return { proposed: state, blockers: ["object_already_exists"] };
      return { proposed: { ...state, object: { name: p.name, ipNetmask: p.ipNetmask, description: `${markFor(opId)}${p.description ? ` ${p.description}` : ""}` } }, blockers: [] };
    },
    inverse: (p, { opId, created }) => ({ changeType: "address-object.delete", params: { name: p.name, mark: opId, expected: created?.object ?? null } })
  },
  "address-object.delete": {
    label: "Delete an address object this system created (matched by its mark)",
    rollbackOnly: true,
    validate: (p) => [...(typeof p.name === "string" && NAME.test(p.name) ? [] : ["name is not valid"]), ...(typeof p.mark === "string" && /^OP-[0-9A-F]{10}$/.test(p.mark) ? [] : ["mark must be an operation id"])],
    plan(state, p) {
      if (!state.object) return { proposed: state, blockers: ["object_not_found"] };
      if (!state.object.description.startsWith(markFor(p.mark))) return { proposed: state, blockers: ["object_not_created_by_that_operation"] };
      // Delete only exactly what was created. If anyone has edited it since, stop and ask for a person's review.
      if (p.expected && !same(state.object, p.expected)) return { proposed: state, blockers: ["object_changed_since_creation"] };
      return { proposed: { ...state, object: null }, blockers: [] };
    },
    inverse: () => null
  }
};

export function planObject({ changeType, params, state, opId, target }) {
  const { proposed, blockers } = CHANGE_TYPES[changeType].plan(state, params, { opId });
  const all = [...blockers, ...(state.pending > 0 ? ["pending_candidate_changes_exist"] : [])];
  const line = (o) => (o ? `address ${o.name} ${o.ipNetmask}${o.description ? ` # ${o.description}` : ""}` : "(absent)");
  return {
    proposed, blockers: all,
    diff: { before: [{ line: line(state.object), change: state.object ? "removed" : "kept" }], after: [{ line: line(proposed.object), change: proposed.object ? "added" : "kept" }] },
    requiresExclusiveWindow: false,
    // Shown in the approval. A candidate edit and a commit are different acts, and the scope of the commit is exact.
    commitScope: { kind: "partial", byAdmin: target.commitAdmin, vsys: target.vsys, objects: [params.name], pendingBefore: state.pending }
  };
}

