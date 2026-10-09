# Lovable UI brief — Insurance Claims Intake Agent

A Lovable build session implements this brief against the presentation layer only. The deterministic policy in `src/scenarios/insurance.ts` owns every decision; the UI displays its results and never decides for it. Adjudication is human-only: the surface prepares a claim for an adjuster and determines nothing.

## Endpoint

The only network call this UI may make: `POST /api/v1/scenarios/insurance/assess`

- Request body matches `examples/labs/insurance.json`: `scenario: "insurance"`, `humanApproval`, `claimId`, `lossType`, `narrative`, `requiredDocuments`, `documents` (each with `type` and `sourceId`), and `facts` (each with `name`, `value`, and `sourceId`).
- Optional query parameter `cloud=aws|gcp` (default `aws`).
- A payload declaring a different scenario is refused with 400 before any field is read. A blocked assessment still answers 200: it is a completed deterministic refusal, not a retryable failure.

## What the UI displays

Source-provenance citations:

- Every material statement displayed is a supported fact: render each entry of `domain.supportedFactNames` with a citation to its source in `domain.evidenceSourceIds`. A claim statement with no cited source does not present as fact.
- `domain.unsupportedFacts` render flagged as unverified — visible, never silently dropped. INS-PROVENANCE fires when a fact references no supplied source.

Missing-documents panel:

- `domain.missingDocuments` lists the required document types with no matching supplied document. Render it as an open gap naming the documents to request. While it is non-empty the claim is not complete, and the UI must not suggest otherwise. INS-EVIDENCE fires when required evidence is missing.

Human-adjudication status:

- `domain.coverageDetermined`, `domain.liabilityDetermined`, and `domain.paymentAuthorized` are `false` in every envelope. Render them as "not determined — human adjuster required," never as decided values.
- `humanApprovalRequired` is `true` in every envelope. Render it as an approval gate that names an authorized adjuster — never as a toggle. INS-APPROVAL fires when `humanApproval` is false.

Narrative handling, cost, and evidence:

- The intake `narrative` stays in the request: `domain.narrativeLogged: false` and it is never copied into displayed evidence. If the UI shows it at all, it is rendered as plain text.
- `findings` render each `id`, `severity`, `message`, and `remediation`. `mode` shows `deterministic` or `claude-assisted`; `recommendation` renders as text and never determines coverage or liability.
- Cost block: `cost.monthlyInputTokens`, `cost.monthlyOutputTokens`, `cost.estimatedMonthlyUsd`, `cost.pricingSource`.
- `evidence.promptLogged` and `evidence.sensitiveContentLogged` are always `false`; display them so the adjuster can see it.

## Constraints

- No API key or model key in browser code; no client-side secrets of any kind.
- No network calls except the endpoint above.
- Input text is rendered as text — no dynamic HTML strings.
- The UI collects and displays; the envelope decides.
