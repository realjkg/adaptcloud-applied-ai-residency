// Enrollment: which lab a signed-in identity belongs to. Resolved on the server after sign-in, from deployment
// configuration, never from the identity provider's claims alone and never from the browser.
//
// An identity that appears in no lab, or in more than one, resolves to null and gets no session at all.

export function createEnrollment(labs) {
  const owners = new Map();
  for (const [labId, lab] of Object.entries(labs)) {
    for (const subject of lab.members ?? []) owners.set(subject, [...(owners.get(subject) ?? []), labId]);
  }
  return {
    resolve(subject) {
      const found = typeof subject === "string" ? owners.get(subject) : undefined;
      return found && found.length === 1 ? found[0] : null;
    },
    labs: () => Object.keys(labs)
  };
}
