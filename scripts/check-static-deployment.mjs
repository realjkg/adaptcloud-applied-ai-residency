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

process.stdout.write(`${JSON.stringify({ status: "healthy", url: response.url })}\n`);
