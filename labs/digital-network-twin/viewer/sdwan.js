const metrics = [
  ["latencyMs", "Latency (ms)", 100, 40],
  ["jitterMs", "Jitter (ms)", 20, 5],
  ["lossPct", "Loss (%)", 1, 0.1]
];
const panel = document.querySelector("#sdwan");
const form = panel.querySelector("form");
const status = panel.querySelector('[role="status"]');
const fields = form.querySelector("[data-sdwan-metrics]");

for (const [group, title] of [
  ["thresholds", "Policy thresholds"],
  ["wan1", "WAN 1 observations"],
  ["wan2", "WAN 2 observations"]
]) {
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = title;
  fieldset.append(legend);
  for (const [key, caption, limit, sample] of metrics) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.name = group + "." + key;
    input.type = "number";
    input.min = "0";
    input.step = "any";
    input.required = true;
    if (key === "lossPct") input.max = "100";
    input.defaultValue = String(group === "thresholds" ? limit : sample);
    label.append(caption + " ", input);
    fieldset.append(label);
  }
  fields.append(fieldset);
}

let csrf = null;
let previous = null;
let sessionRevision = 0;
let evaluationRevision = 0;
let pending = null;

function clearResult() {
  evaluationRevision++;
  pending?.abort();
  pending = null;
  status.textContent = "";
}

async function refreshSession() {
  const revision = ++sessionRevision;
  const me = await fetch("/api/me", { cache: "no-store" })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (revision !== sessionRevision) return;
  const next = me && ["simulator", "learner"].includes(me.mode) &&
    me.permissions?.includes("operation:read") && typeof me.csrf === "string"
    ? me.csrf : null;
  if (next !== csrf) {
    csrf = next;
    form.reset();
  }
  panel.hidden = !csrf;
}

form.addEventListener("input", clearResult);
form.addEventListener("invalid", clearResult, true);
form.addEventListener("reset", () => {
  previous = null;
  clearResult();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!csrf || !form.reportValidity()) return;
  clearResult();
  const revision = evaluationRevision;
  const controller = new AbortController();
  pending = controller;
  status.textContent = "Evaluating…";
  const data = new FormData(form);
  const values = group => Object.fromEntries(
    metrics.map(([key]) => [key, Number(data.get(group + "." + key))])
  );
  const preferred = data.get("preferred");

  try {
    const response = await fetch("/api/sdwan/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      signal: controller.signal,
      body: JSON.stringify({
        policy: {
          preferred,
          backup: preferred === "wan1" ? "wan2" : "wan1",
          failback: data.get("failback"),
          thresholds: values("thresholds")
        },
        observations: { wan1: values("wan1"), wan2: values("wan2") },
        previous
      })
    });
    const result = await response.json();
    if (revision !== evaluationRevision) return;
    if (!response.ok) {
      status.textContent = "Evaluation failed: " + (result.error ?? response.status);
      if (response.status === 401 || response.status === 403) void refreshSession();
      return;
    }
    previous = result.selected;
    status.textContent = (previous ?? "No eligible uplink") + " — " +
      result.reason.replaceAll("_", " ");
  } catch {
    if (revision === evaluationRevision && !controller.signal.aborted) {
      status.textContent = "Evaluation failed: service unavailable";
    }
  } finally {
    if (pending === controller) pending = null;
  }
});

let timer;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshSession(), 50);
}).observe(document.querySelector("#operate"), { childList: true, subtree: true });
void refreshSession();
