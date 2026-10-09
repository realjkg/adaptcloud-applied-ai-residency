# Lovable UI brief — Payments Exceptions Agent

A Lovable build session implements this brief against the presentation layer only. The deterministic policy in `src/scenarios/payments.ts` owns every decision; the UI displays its results and never decides for it. The failure posture is fail-closed: the surface reports an exception for operator review and offers nothing that could move funds.

## Endpoint

The only network call this UI may make: `POST /api/v1/scenarios/payments/assess`

- Request body matches `examples/labs/payments.json`: `scenario: "payments"`, `humanApproval`, `transactionId`, `currency`, and `events` — each event carrying `type` (one of `authorization`, `capture`, `settlement`, `reversal`, `refund`), `amountMinor`, `currency`, `idempotencyKey`, `sourceId`.
- Optional query parameter `cloud=aws|gcp` (default `aws`).
- A payload declaring a different scenario is refused with 400 before any field is read. A blocked assessment still answers 200: it is a completed deterministic refusal, not a retryable failure.

## What the UI displays

Reconciliation timeline:

- Every request event is a timeline row: `type`, `amountMinor`, `currency`, `idempotencyKey`, and `sourceId`, aligned with `domain.timelineSourceIds`.
- The per-type totals the policy computed: `domain.capturedMinor`, `domain.settledMinor`, `domain.reversedMinor`, `domain.refundedMinor`, headed by `domain.transactionId` and `domain.eventCount`. Amounts are integer minor units — the display never rounds or converts them client-side.

Blocking-invariant display:

- `domain.fundsMoved: false` and `domain.fraudDecisionMade: false` render as persistent status text, not dismissible badges or toggles.
- Findings render with their `message` and `remediation`: PAY-CURRENCY (an event contradicts the transaction currency), PAY-IDEMPOTENCY (duplicate idempotency keys block reconciliation), PAY-LEDGER (capture, settlement, reversal, and refund totals do not reconcile). When `status` is `blocked`, the UI routes the exception to an operator and offers no control that could release or retry funds.

Approval gate:

- `humanApprovalRequired` is `true` in every envelope. Render it as an approval gate that names an authorized reviewer — never as a toggle. PAY-APPROVAL fires when `humanApproval` is false.

Cost and evidence:

- Cost block: `cost.monthlyInputTokens`, `cost.monthlyOutputTokens`, `cost.estimatedMonthlyUsd`, `cost.pricingSource`.
- `evidence.promptLogged` and `evidence.sensitiveContentLogged` are always `false`; display them so the operator can see it. `mode` shows `deterministic` or `claude-assisted`; `recommendation` renders as text.

## Constraints

- No API key or model key in browser code; no client-side secrets of any kind.
- No network calls except the endpoint above.
- Input text is rendered as text — no dynamic HTML strings.
- The UI collects and displays; the envelope decides.
