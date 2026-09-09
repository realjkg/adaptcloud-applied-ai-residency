import type { McpProvider } from "./contracts.js";

/**
 * Credential custody for the MCP connector layer (SECURITY.md: no committed or static secrets).
 *
 * There is no static credential path here by construction: this module reads no environment
 * variable, no file, and no process state. A credential is produced at call time by an injected
 * resolver backed by the hosting platform's workload identity or an OIDC token exchange, so tests
 * and labs need no real identity and a long-lived key has nowhere to enter.
 *
 * The secret is held in a private field and every serialization path — `toJSON`, `toString`, the
 * primitive coercion, and the inspect hook — yields the redaction placeholder. A credential
 * therefore cannot be logged, embedded in a result, or interpolated into an error message by
 * accident; reaching the value requires calling `reveal()`, which only the transport does.
 */

export const redactedPlaceholder = "[redacted]";

export type CredentialKind = "workload-identity" | "oidc-exchange";

export interface CredentialRequest {
  readonly connectorId: string;
  readonly provider: McpProvider;
  readonly operation: string;
  /** The connector host the credential is scoped to; a token minted for one host is useless at another. */
  readonly audience: string;
  readonly scopes: readonly string[];
}

export interface ShortLivedCredential {
  readonly kind: CredentialKind;
  readonly expiresAt: string;
  reveal: () => string;
  toJSON: () => string;
  toString: () => string;
}

export type CredentialResolution =
  | { readonly ok: true; readonly credential: ShortLivedCredential }
  | { readonly ok: false; readonly reason: "credential_unavailable" };

export interface CredentialResolver {
  readonly kind: CredentialKind | "denied";
  resolve: (request: CredentialRequest) => Promise<CredentialResolution>;
}

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

class OpaqueCredential implements ShortLivedCredential {
  readonly #secret: string;
  readonly kind: CredentialKind;
  readonly expiresAt: string;

  constructor(secret: string, kind: CredentialKind, expiresAt: string) {
    this.#secret = secret;
    this.kind = kind;
    this.expiresAt = expiresAt;
  }

  reveal(): string {
    return this.#secret;
  }

  toJSON(): string {
    return redactedPlaceholder;
  }

  toString(): string {
    return redactedPlaceholder;
  }

  [inspectSymbol](): string {
    return redactedPlaceholder;
  }
}

/** Wraps a platform-minted, short-lived token so it cannot be serialized or printed. */
export function shortLivedCredential(secret: string, kind: CredentialKind, expiresAt: string): ShortLivedCredential {
  return new OpaqueCredential(secret, kind, expiresAt);
}

/** The default resolver: with no platform identity injected, every call is refused. */
export const deniedResolver: CredentialResolver = {
  kind: "denied",
  resolve: async () => ({ ok: false, reason: "credential_unavailable" })
};

/**
 * Last-resort redaction for text that is about to be recorded. It is a safety net for a value
 * that escaped the opaque wrapper, not a licence to handle raw secrets: prefer never holding one.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    redacted = redacted.split(secret).join(redactedPlaceholder);
  }
  return redacted;
}
