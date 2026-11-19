// Shared by the write adapters (live and simulated): digests, diffs, error classification, and the one write routine
// that decides what an uncertain outcome means. Pure except for the functions the caller hands in.

import { createHash } from "node:crypto";
import { stableStringify } from "../../tools/provision-policy.mjs";
import { PRE_SEND_REFUSALS } from "../../tools/refusal-codes.mjs";

export const digest = (value) => createHash("sha256").update(stableStringify(value)).digest("hex");
export const same = (a, b) => stableStringify(a) === stableStringify(b);

/** The mark every object or rule this system creates carries, so a rollback can only touch what it made. */
export const markFor = (opId) => `twin-op:${opId}`;
export const OPID = /^OP-[0-9A-F]{10}$/;

/**
 * A write error is definitive only when the request provably never left: a refusal before sending, or an HTTP 4xx.
 * Everything else (timeout, dropped connection, unreadable reply, 5xx) may have happened on the vendor's side.
 */
export function isDefinitive(error) {
  if (error?.code && PRE_SEND_REFUSALS.has(error.code)) return true;
  return typeof error?.status === "number" && error.status >= 400 && error.status < 500;
}

export class WriteError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/** Lines for an approver: the full ordered before and after lists, with changes marked. */
export function listDiff(before, after, render = (x) => JSON.stringify(x)) {
  const b = before.map((x) => render(x));
  const a = after.map((x) => render(x));
  const inB = new Set(b);
  const inA = new Set(a);
  return {
    before: b.map((line) => ({ line, change: inA.has(line) ? "kept" : "removed" })),
    after: a.map((line) => ({ line, change: inB.has(line) ? "kept" : "added" }))
  };
}

/**
 * Performs one write and decides what happened.
 *   verified   read-back equals the proposed state
 *   failed     nothing was applied (a definitive refusal, or read-back equals the baseline after a retry)
 *   uncertain  the target is in neither state, or could not be read; nothing further is written
 * If the write's outcome is unknown, the target is read first. A write is retried at most once, and only when the
 * read shows the baseline untouched.
 */
export async function guardedWrite({ write, read, baseline, proposed }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let writeError = null;
    try { await write(); } catch (error) { writeError = error; }
    if (writeError && isDefinitive(writeError)) return { outcome: "failed", reason: writeError.code ?? "write_refused", attempts };
    let observed;
    try { observed = await read(); } catch { return { outcome: "uncertain", reason: "state_unreadable_after_write", attempts }; }
    if (same(observed, proposed)) return { outcome: "verified", attempts, ...(writeError ? { note: "write_response_lost_state_verified" } : {}) };
    if (same(observed, baseline)) {
      if (writeError && attempts < 2) continue;
      return { outcome: "failed", reason: writeError ? "not_applied_after_retry" : "readback_equals_baseline", attempts };
    }
    return { outcome: "uncertain", reason: "state_differs_from_both", attempts, observedDigest: digest(observed) };
  }
}
