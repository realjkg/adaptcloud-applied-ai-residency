const scenarios = {
  commercial: {
    description: "Draft maintenance opportunities while keeping scheduling, purchasing, and financial promises behind human approval.",
    invariant: "work_order.submit=false",
    costUnit: "reviewed_opportunity"
  },
  payments: {
    description: "Reconcile synthetic payment events without moving money, judging fraud, or allowing a model to alter ledger facts.",
    invariant: "funds_movement.allowed=false",
    costUnit: "reconciled_exception"
  },
  insurance: {
    description: "Map claim evidence and uncertainty without determining coverage, liability, claim value, denial, or payment.",
    invariant: "claim.adjudication=human_only",
    costUnit: "reviewed_intake"
  }
};

const stages = [
  { id: "baseline", title: "Establish the baseline", detail: "Typecheck, tests, adversarial evals, and inherited-state evidence.", signal: "quality.gates" },
  { id: "boundary", title: "Map trust and policy boundaries", detail: "Separate deterministic controls, model reasoning, and human authority.", signal: "controls.evaluated" },
  { id: "deterministic", title: "Run without credentials", detail: "Prove safe behavior with synthetic input and no external model call.", signal: "agent.assessment" },
  { id: "telemetry", title: "Inspect operational signals", detail: "Review metadata-only spans, cost, latency, fallback, and outcomes.", signal: "telemetry.review" },
  { id: "readiness", title: "Evaluate production readiness", detail: "Expose gaps across security, resilience, reliability, cost, sustainability, and operations.", signal: "readiness.assessed" },
  { id: "artifact", title: "Prove the immutable artifact", detail: "Build and scan the non-root container without publishing credentials.", signal: "artifact.verified" },
  { id: "promotion", title: "Rehearse the promotion decision", detail: "Review an infrastructure plan, SLO gates, rollback, and owner approval—without applying it.", signal: "promotion.reviewed" }
];

let selectedScenario = "commercial";
let selectedStage = 0;
const observed = new Set();

const stageList = document.querySelector("#stage-list");
const spanPreview = document.querySelector("#span-preview");
const progressBar = document.querySelector("#progress-bar");
const progressLabel = document.querySelector("#progress-label");
const traceScenario = document.querySelector("#trace-scenario");
const traceStatus = document.querySelector("#trace-status");
const scenarioDescription = document.querySelector("#scenario-description");

function renderStages() {
  stageList.replaceChildren(...stages.map((stage, index) => {
    const item = document.createElement("li");
    item.className = `stage-item${index === selectedStage ? " selected" : ""}${observed.has(stage.id) ? " observed" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stage-button";
    button.dataset.stage = String(index);
    button.innerHTML = `<span class="stage-copy"><strong>${stage.title}</strong><small>${stage.detail}</small></span><span class="stage-state">${observed.has(stage.id) ? "Observed" : "Pending"}</span>`;
    item.append(button);
    return item;
  }));
  const percent = observed.size / stages.length * 100;
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = `${observed.size} of ${stages.length} observed`;
}

function syntheticId(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function observeSelectedStage() {
  const stage = stages[selectedStage];
  const scenario = scenarios[selectedScenario];
  observed.add(stage.id);
  const preview = {
    resource: {
      "service.name": "adaptcloud.residency.lab",
      "deployment.environment": "walkthrough",
      "adaptcloud.synthetic": true,
      "adaptcloud.cloud_mutation": false
    },
    span: {
      name: `residency.${stage.signal}`,
      traceId: syntheticId(32),
      spanId: syntheticId(16),
      status: "OK",
      attributes: {
        "adaptcloud.scenario": selectedScenario,
        "adaptcloud.stage": stage.id,
        "adaptcloud.domain_invariant": scenario.invariant,
        "adaptcloud.cost_unit": scenario.costUnit,
        "adaptcloud.human_approval_required": true,
        "adaptcloud.prompt_logged": false,
        "adaptcloud.export_enabled": false
      },
      events: [{ name: "evidence.recorded", attributes: { "evidence.synthetic": true } }]
    }
  };
  spanPreview.textContent = JSON.stringify(preview, null, 2);
  traceStatus.textContent = "observed";
  renderStages();
}

document.querySelector(".scenario-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-scenario]");
  if (!button) return;
  selectedScenario = button.dataset.scenario;
  document.querySelectorAll("[data-scenario]").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  scenarioDescription.textContent = scenarios[selectedScenario].description;
  traceScenario.textContent = selectedScenario;
  spanPreview.textContent = "Select a stage, then observe it.";
  traceStatus.textContent = "waiting";
});

stageList.addEventListener("click", event => {
  const button = event.target.closest("[data-stage]");
  if (!button) return;
  selectedStage = Number(button.dataset.stage);
  renderStages();
});

document.querySelector("#observe-button").addEventListener("click", observeSelectedStage);
document.querySelector("#reset-button").addEventListener("click", () => {
  observed.clear();
  selectedStage = 0;
  spanPreview.textContent = "Select a stage, then observe it.";
  traceStatus.textContent = "waiting";
  renderStages();
});

renderStages();
