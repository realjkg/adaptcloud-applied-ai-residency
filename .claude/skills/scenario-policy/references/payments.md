# Banking and payments: exception investigation

**Shape:** a payments operations team submits a synthetic transaction with processor and ledger
events. The agent returns a chronological timeline, a reconciliation result, duplicate and
idempotency findings, contradictions, a recommended next step, escalation severity, and immutable
evidence metadata.

**Implementation:** `paymentsPolicy` in `src/labs/simulator.ts`; fixture
`examples/labs/payments.json`.

## Invariants

- **Never move money.** No initiation, capture, settlement, refund, reversal, or freeze. The
  domain output asserts `fundsMoved: false`.
- **Never accept or store** a real PAN, CVV, bank-account number, credential, or customer record.
  Synthetic identifiers only.
- **Never decide a person committed fraud** and never file an autonomous regulatory report. The
  domain output asserts `fraudDecisionMade: false`. The agent evidences; humans adjudicate.
- Monetary values are integer minor units with an explicit currency, validated as safe integers.
- Duplicate idempotency keys and ledger imbalance are **deterministic blocking findings**, not
  model observations.
- Model text may explain evidence but cannot change a ledger fact, a severity, or approval state.
- PCI-DSS and SOC 2 references are control-readiness mappings only — never certification claims.

## Blocking findings

| Id | Raised when | Why it blocks |
|---|---|---|
| `PAY-IDEMPOTENCY` | an idempotency key repeats across events | duplicate processing is indistinguishable from double movement until a human checks |
| `PAY-LEDGER` | `captured ≠ settled + reversed`, or `refunded > settled` | the evidence does not reconcile; an unexplained imbalance escalates rather than resolves |
| `PAY-CURRENCY` | an event's currency differs from the transaction currency | mixed-currency arithmetic is silently wrong |
| `PAY-APPROVAL` | `humanApproval` is false | an exception needs an authorized operator |

## Why the reconciliation identity matters

`captured = settled + reversed` and `refunded ≤ settled` are the arithmetic the whole scenario
rests on. They are cheap to check, impossible to argue with, and they catch the realistic failure
— a partially applied reversal, a duplicated capture, a settlement that never landed. A model
asked to "check whether this reconciles" will sometimes say yes to an imbalance. Deterministic
arithmetic never will, which is precisely why this check is code.

## Operating envelope

99.9% availability, 30-minute RTO, 5-minute RPO — the tightest of the three. Failure posture:
**fail closed**, preserve immutable event references, never move funds. Cost unit: **cost per
reconciled exception**. Retention: governed record schedule, with no PAN, CVV, or account data
at any point.

Fail-closed is the load-bearing choice. In commercial and insurance, degradation means a slower
human review; here it means an unreconciled exception must stop, because the alternative is a
money-movement decision made on incomplete evidence.

## Extending safely

Read-only investigation only. Anything that could initiate, modify, or release a payment is out
of scope for this repository and needs explicit human approval, a threat model, and tests before
it is even designed. New event types must extend the reconciliation identity and gain a probe in
the same change.
