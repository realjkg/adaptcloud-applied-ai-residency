// OpenID Connect sign-in (authorization code with PKCE). Works with any standards-based identity provider, such as
// Entra ID, Okta, Google Workspace, or Keycloak. NOT TESTED AGAINST A REAL PROVIDER: it is checked against a local
// provider that signs tokens with a test key.
//
// The ID token is verified here, not trusted: signature against the provider's published keys (RS256 only), issuer,
// audience, expiry, issued-at, and the nonce this server created for this sign-in. The state value binds the callback
// to the browser that started it. Provider URLs are fixed in configuration and must be https.

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const rand = () => randomBytes(32).toString("base64url");
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export function createOidc({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), leewaySeconds = 60 }) {
  for (const key of ["issuer", "authorizationEndpoint", "tokenEndpoint", "jwksUri"]) if (!String(config[key] ?? "").startsWith("https://")) throw new Error(`oidc ${key} must be an https URL`);
  if (!config.clientId || !config.redirectUri) throw new Error("oidc needs clientId and redirectUri");
  const pending = new Map();
  let jwks = null;
  let jwksAt = 0;

  async function keys(force = false) {
    if (!force && jwks && now() - jwksAt < 600_000) return jwks;
    const res = await fetchImpl(config.jwksUri, { redirect: "manual" });
    if (res.status !== 200) throw new Error("jwks_unavailable");
    jwks = (await res.json()).keys ?? [];
    jwksAt = now();
    return jwks;
  }

  async function verifyIdToken(idToken, nonce) {
    const parts = String(idToken).split(".");
    if (parts.length !== 3) throw new Error("token_malformed");
    let header; let claims;
    try { header = decode(parts[0]); claims = decode(parts[1]); } catch { throw new Error("token_malformed"); }
    if (header.alg !== "RS256") throw new Error("alg_not_allowed");
    let list = await keys();
    let jwk = list.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) { list = await keys(true); jwk = list.find((k) => k.kid === header.kid && k.kty === "RSA"); }
    if (!jwk) throw new Error("key_unknown");
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    if (!ok) throw new Error("signature_invalid");
    const t = Math.floor(now() / 1000);
    if (claims.iss !== config.issuer) throw new Error("issuer_mismatch");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(config.clientId)) throw new Error("audience_mismatch");
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) throw new Error("azp_mismatch");
    if (typeof claims.exp !== "number" || claims.exp + leewaySeconds < t) throw new Error("token_expired");
    if (typeof claims.iat !== "number" || claims.iat - leewaySeconds > t) throw new Error("token_from_future");
    if (claims.nonce !== nonce) throw new Error("nonce_mismatch");
    if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new Error("subject_missing");
    return claims;
  }

  return {
    /** Starts a sign-in. Returns the provider URL to send the browser to. */
    begin() {
      const state = rand(); const nonce = rand(); const verifier = rand();
      pending.set(state, { nonce, verifier, at: now() });
      for (const [k, v] of pending) if (now() - v.at > 600_000) pending.delete(k);
      const q = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope ?? "openid profile email", state, nonce, code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" });
      return `${config.authorizationEndpoint}?${q}`;
    },
    /** Completes a sign-in. Returns { subject, name, groups } or throws a short code. */
    async complete({ state, code }) {
      const p = typeof state === "string" ? pending.get(state) : undefined;
      pending.delete(state);
      if (!p || now() - p.at > 600_000) throw new Error("state_invalid");
      if (typeof code !== "string" || code.length === 0 || code.length > 2048) throw new Error("code_invalid");
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: p.verifier });
      const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      if (config.clientSecret) headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret.reveal?.() ?? config.clientSecret}`).toString("base64")}`;
      const res = await fetchImpl(config.tokenEndpoint, { method: "POST", headers, body, redirect: "manual" });
      if (res.status !== 200) throw new Error("token_exchange_failed");
      const tokens = await res.json();
      const claims = await verifyIdToken(tokens.id_token, p.nonce);
      const groups = claims[config.groupsClaim ?? "groups"];
      return { subject: claims.sub, name: typeof claims.name === "string" ? claims.name.slice(0, 80) : claims.sub, groups: Array.isArray(groups) ? groups.filter((g) => typeof g === "string") : [] };
    }
  };
}
