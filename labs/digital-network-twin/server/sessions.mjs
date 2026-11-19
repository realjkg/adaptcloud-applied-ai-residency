// Server-side sessions. The browser holds only an unguessable id in an HttpOnly, SameSite=Strict cookie. Each session
// has an idle timeout and an absolute lifetime, and its own CSRF token that every state-changing request must echo.

import { randomBytes, timingSafeEqual } from "node:crypto";

const token = () => randomBytes(32).toString("base64url");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createSessions({ idleMs = 15 * 60_000, absoluteMs = 8 * 3_600_000, now = () => Date.now() } = {}) {
  const sessions = new Map();
  return {
    create(user) {
      const id = token();
      const t = now();
      sessions.set(id, { user, csrf: token(), createdAt: t, lastSeen: t });
      return { id, csrf: sessions.get(id).csrf };
    },
    get(id) {
      const s = typeof id === "string" ? sessions.get(id) : undefined;
      if (!s) return null;
      const t = now();
      if (t - s.lastSeen > idleMs || t - s.createdAt > absoluteMs) { sessions.delete(id); return null; }
      s.lastSeen = t;
      return s;
    },
    csrfOk: (s, presented) => same(s?.csrf, presented),
    destroy(id) { sessions.delete(id); },
    size: () => sessions.size
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
