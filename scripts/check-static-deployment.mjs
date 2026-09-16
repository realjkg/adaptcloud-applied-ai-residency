const configuredUrl = process.env.DEPLOYMENT_URL;

if (!configuredUrl) {
  throw new Error("DEPLOYMENT_URL is required");
}

const url = new URL(configuredUrl);
if (url.protocol !== "https:") {
  throw new Error("DEPLOYMENT_URL must use https");
}

const response = await fetch(url, {
  redirect: "follow",
  signal: AbortSignal.timeout(15_000)
});
const body = await response.text();

if (!response.ok) {
  throw new Error(`deployment returned HTTP ${response.status}`);
}
if (body.includes("FUNCTION_INVOCATION_FAILED")) {
  throw new Error("deployment routed the static page through a failed function");
}
if (!body.includes("Adapt Cloud Applied AI Engineer Residency")) {
  throw new Error("deployment did not return the expected static walkthrough");
}

const requiredHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'"
  ],
  "referrer-policy": ["no-referrer"],
  "x-content-type-options": ["nosniff"],
  "x-frame-options": ["DENY"],
  "cross-origin-opener-policy": ["same-origin"],
  "cross-origin-resource-policy": ["same-origin"]
};

for (const [name, expectedValues] of Object.entries(requiredHeaders)) {
  const actual = response.headers.get(name);
  if (!actual) throw new Error(`deployment is missing ${name}`);
  for (const expected of expectedValues) {
    if (!actual.includes(expected)) {
      throw new Error(`deployment ${name} is missing ${expected}`);
    }
  }
}

process.stdout.write(`${JSON.stringify({ status: "healthy", securityHeaders: "verified", url: response.url })}\n`);
