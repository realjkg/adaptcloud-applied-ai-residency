// Browser tests are part of the acceptance evidence for learner isolation. In CI (CI=true) or when TWIN_REQUIRE_BROWSER=1,
// missing Playwright FAILS the test instead of skipping it, so the gate cannot go green without a browser run.
import { test } from "node:test";
import { createRequire } from "node:module";

let playwright = null;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* handled below */ }

export { playwright };
export const BROWSER_REQUIRED = process.env.CI === "true" || process.env.TWIN_REQUIRE_BROWSER === "1";

/** The gate itself, with its inputs explicit so it can be tested. */
export function gate({ register, pw, required }, name, fn) {
  if (pw) return register(name, fn);
  if (required) return register(name, () => { throw new Error("Playwright is required here (CI or TWIN_REQUIRE_BROWSER=1) but is not installed, so this browser test cannot be skipped"); });
  return register(name, { skip: "playwright not installed (set TWIN_REQUIRE_BROWSER=1 to require it)" }, () => {});
}

export const browserTest = (name, fn) => gate({ register: test, pw: playwright, required: BROWSER_REQUIRED }, name, fn);
