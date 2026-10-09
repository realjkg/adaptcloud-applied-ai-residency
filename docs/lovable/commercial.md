# Lovable UI brief — Commercial Maintenance Opportunity Agent

A Lovable build session implements this brief against the presentation layer only. The deterministic policy in `src/scenarios/commercial.ts` owns every decision; the UI displays its results and never decides for it. This is an assessment surface: it drafts, it does not execute.

## Endpoint

The only network call this UI may make: `POST /api/v1/scenarios/commercial/assess`

- Request body matches `examples/labs/commercial.json`: `scenario: "commercial"`, `humanApproval`, `assetId`, `maintenanceObservations`, `downtimeHours`, `hourlyDowntimeCostMinor`, `laborHours`, `laborRateMinor`, `materialCostMinor`, `currency`, `requestedActions`.
- Optional query parameter `cloud=aws|gcp` (default `aws`).
- A payload declaring a different scenario is refused with 400 before any field is read. A blocked assessment still answers 200: it is a completed deterministic refusal, not a retryable failure.

## What the UI displays

Beside every financial estimate (`estimatedLaborCostMinor`, `estimatedMaterialCostMinor`, `estimatedDowntimeEffectMinor`):

- The matching `domain.assumptions` entry ("labor hours and rates are estimates", "downtime effect is not a promised saving") rendered as a missing-information question the human answers before treating the number as more than an estimate. Estimates and observed facts stay visually distinct.
- Amounts are integer minor units with the response `currency`. The UI formats them for display but never invents, rounds, or totals figures client-side.

Work-order draft:

- `domain.workOrderDrafted: true` means a draft exists. Label it DRAFT and give it no submit, schedule, purchase, or vendor-contact control. Those actions (`submit-work-order`, `schedule-labor`, `purchase-material`, `contact-vendor`) are prohibited by policy and produce the COM-ACTION critical finding; the UI must not offer them.
- `domain.externalActionTaken: false` is displayed as a standing statement: nothing was executed.

Approval gate:

- `humanApprovalRequired` is `true` in every envelope. Render it as an approval gate that names an accountable approver — never as a toggle the UI user can flip. COM-APPROVAL fires when `humanApproval` is false.

Findings, recommendation, cost, evidence:

- `findings` render each `id`, `severity`, `message`, and `remediation`. `mode` shows `deterministic` or `claude-assisted`; `recommendation` renders as text and never authorizes anything.
- Cost block: `cost.monthlyInputTokens`, `cost.monthlyOutputTokens`, `cost.estimatedMonthlyUsd`, `cost.pricingSource`.
- `evidence.promptLogged` and `evidence.sensitiveContentLogged` are always `false`; display them so the operator can see it.

## Constraints

- No API key or model key in browser code; no client-side secrets of any kind.
- No network calls except the endpoint above.
- Input text is rendered as text — no dynamic HTML strings.
- The UI collects and displays; the envelope decides.
