import { test } from "node:test";
import assert from "node:assert/strict";
import { gate } from "./browser.mjs";

const run = (inputs) => {
  const registered = [];
  gate({ register: (...args) => registered.push(args), ...inputs }, "t", () => "ran");
  return registered[0];
};

test("browser gate: with a browser the test runs", () => {
  const [name, fn] = run({ pw: {}, required: true });
  assert.equal(name, "t");
  assert.equal(fn(), "ran");
});

test("browser gate: without a browser where one is required, the test FAILS rather than skips", () => {
  const [, fn, extra] = run({ pw: null, required: true });
  assert.equal(extra, undefined, "no skip option");
  assert.throws(() => fn(), /Playwright is required/);
});

test("browser gate: without a browser and not required, the test is skipped", () => {
  const [, options] = run({ pw: null, required: false });
  assert.match(options.skip, /TWIN_REQUIRE_BROWSER/);
});
