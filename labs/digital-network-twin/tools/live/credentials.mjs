// Credentials are read from the environment at call time, wrapped so they cannot reach a log or a result,
// and never come from config, policy, or this repository.

const REDACTED = "[redacted]";

class Secret {
  #value;
  constructor(value) {
    this.#value = value;
  }

  reveal() {
    return this.#value;
  }

  toString() {
    return REDACTED;
  }

  toJSON() {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return REDACTED;
  }
}

/** Throws a message that names the variable but never a value. */
export function secretFromEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`credential_unavailable: ${name}`);
  return new Secret(value);
}
