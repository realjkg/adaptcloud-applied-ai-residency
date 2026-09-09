# Commercial operations: maintenance opportunity

**Shape:** an industrial or field-services team submits asset observations, urgency, downtime and
labour assumptions, and requested actions. The agent returns a prioritized recommendation, an
estimate with its assumptions, a drafted work order, and an explicit approval status.

**Implementation:** `commercialPolicy` in `src/labs/simulator.ts`; fixture
`examples/labs/commercial.json`.

## Invariants

- May **draft** a work order; may never submit it, contact a vendor, schedule labour, or purchase
  material. `requestedActions` is checked against a prohibited list, so the refusal does not
  depend on the model reading a rule.
- Financial estimates are deterministic, state their assumptions, and distinguish estimate from
  observed fact. `assumptions` ships in the domain output for exactly this reason.
- Never promise a saving. Downtime effect is an *estimated effect*, not a guaranteed reduction —
  the distinction is what keeps an estimate out of contract territory.
- Customer text cannot alter tool permissions or policy.

## Blocking findings

| Id | Raised when | Why it blocks |
|---|---|---|
| `COM-ACTION` | a prohibited execution action is requested | the boundary between recommending and acting |
| `COM-APPROVAL` | `humanApproval` is false | consequential work needs an accountable approver |

Both are `critical`, so `runLabSimulation` returns `blocked`.

## Money

Integer minor units throughout — `hourlyDowntimeCostMinor`, `laborRateMinor`,
`materialCostMinor` — validated as non-negative safe integers, with `currency` explicit. Costs
are computed with `Math.round` after multiplication, never accumulated as floats.

## Operating envelope

99.5% availability, 4-hour RTO, 24-hour RPO. Failure posture: queue drafts; never schedule or
purchase automatically. Cost unit: **cost per reviewed opportunity**. Retention: short-lived
operational evidence on a customer-approved schedule.

## Extending safely

New capability starts read-only and draft-only. Any move toward execution — a vendor lookup, a
scheduling integration, a purchase-order API — crosses the action boundary and needs explicit
human approval and tests before implementation, per `CLAUDE.md` rule 3. Bring the failure
analysis, not a finished branch.
