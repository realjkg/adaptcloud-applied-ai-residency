// Local development console for the versioned scenario routes. It never holds a credential:
// the API key, when one is configured at all, stays server-side. This file is deliberately
// outside public/ so it is never part of the static Vercel deployment.
const scenarioField = document.getElementById("scenario");
const cloudField = document.getElementById("cloud");
const payloadField = document.getElementById("payload");
const resultSection = document.getElementById("result");
const verdict = document.getElementById("verdict");
const summary = document.getElementById("summary");
const findings = document.getElementById("findings");
const envelope = document.getElementById("envelope");

async function loadFixture() {
  const response = await fetch(`/fixtures/${scenarioField.value}.json`);
  payloadField.value = JSON.stringify(await response.json(), null, 2);
}

function describe(pairs) {
  summary.replaceChildren();
  for (const [term, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    summary.append(dt, dd);
  }
}

function render(status, body) {
  resultSection.hidden = false;
  findings.replaceChildren();
  // Server content is rendered as text, never as markup. A finding message is data.
  envelope.textContent = JSON.stringify(body, null, 2);
  if (status !== 200) {
    verdict.className = "blocked";
    verdict.textContent = `Rejected (HTTP ${status}): ${body.error ?? "unknown error"}`;
    describe([["http", status]]);
    return;
  }
  verdict.className = body.status === "blocked" ? "blocked" : "ready";
  verdict.textContent = body.status === "blocked"
    ? "Blocked by deterministic policy. A human must resolve the critical findings."
    : "Ready for human review. Nothing was submitted, moved, or adjudicated.";
  describe([
    ["scenario", body.scenario],
    ["cloud", body.cloud],
    ["mode", body.mode],
    ["human approval required", body.humanApprovalRequired],
    ["estimated monthly cost", `$${body.cost.estimatedMonthlyUsd}`],
    ["terraform root", body.evidence.terraformRoot],
    ["prompt logged", body.evidence.promptLogged]
  ]);
  for (const finding of body.findings) {
    const item = document.createElement("li");
    const severity = document.createElement("span");
    severity.className = "severity";
    severity.textContent = `${finding.severity.toUpperCase()} ${finding.id} `;
    item.append(severity, document.createTextNode(finding.message));
    findings.append(item);
  }
  if (body.findings.length === 0) findings.append(Object.assign(document.createElement("li"), { textContent: "none" }));
}

document.getElementById("assess").addEventListener("submit", async (event) => {
  event.preventDefault();
  let parsed;
  try {
    parsed = JSON.parse(payloadField.value);
  } catch (error) {
    render(0, { error: `request is not valid JSON: ${error.message}` });
    return;
  }
  const response = await fetch(`/api/v1/scenarios/${scenarioField.value}/assess?cloud=${cloudField.value}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed)
  });
  render(response.status, await response.json());
});

document.getElementById("reset").addEventListener("click", loadFixture);
scenarioField.addEventListener("change", loadFixture);
void loadFixture();
