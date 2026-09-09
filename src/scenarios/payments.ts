import type { ControlFinding } from "../agent/contracts.js";
import {
  asRecord,
  assertSafeInteger,
  criticalFinding,
  requireArray,
  requireBoolean,
  requireSafeInteger,
  requireString,
  type ScenarioModule,
  type ScenarioPolicyResult
} from "./contracts.js";

export interface PaymentEvent {
  type: "authorization" | "capture" | "settlement" | "reversal" | "refund";
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  sourceId: string;
}

export interface PaymentsLabInput {
  scenario: "payments";
  humanApproval: boolean;
  transactionId: string;
  currency: string;
  events: PaymentEvent[];
}

export const paymentsFindingIds = ["PAY-CURRENCY", "PAY-IDEMPOTENCY", "PAY-LEDGER", "PAY-APPROVAL"] as const;
export type PaymentsFindingId = (typeof paymentsFindingIds)[number];

const paymentEventTypes = new Set<PaymentEvent["type"]>(["authorization", "capture", "settlement", "reversal", "refund"]);

function parsePaymentEvent(value: unknown, index: number): PaymentEvent {
  const event = asRecord(value, `events[${index}]`);
  const type = event.type;
  if (typeof type !== "string" || !paymentEventTypes.has(type as PaymentEvent["type"])) {
    throw new Error(`events[${index}].type must be a supported payment event type`);
  }
  return {
    type: type as PaymentEvent["type"],
    amountMinor: requireSafeInteger(event, "amountMinor"),
    currency: requireString(event, "currency"),
    idempotencyKey: requireString(event, "idempotencyKey"),
    sourceId: requireString(event, "sourceId")
  };
}

function parsePayments(record: Record<string, unknown>): PaymentsLabInput {
  const events = requireArray(record, "events");
  if (events.length === 0) throw new Error("events must contain at least one payment event");
  return {
    scenario: "payments",
    humanApproval: requireBoolean(record, "humanApproval"),
    transactionId: requireString(record, "transactionId"),
    currency: requireString(record, "currency"),
    events: events.map(parsePaymentEvent)
  };
}

function paymentsPolicy(input: PaymentsLabInput): ScenarioPolicyResult {
  const findings: ControlFinding[] = [];
  const keys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const event of input.events) {
    assertSafeInteger(event.amountMinor, "event amountMinor");
    if (!event.currency || event.currency !== input.currency) findings.push(criticalFinding("PAY-CURRENCY", "Every payment event must use the transaction currency.", "Correct or quarantine the contradictory event."));
    if (keys.has(event.idempotencyKey)) duplicateKeys.add(event.idempotencyKey);
    keys.add(event.idempotencyKey);
  }
  if (duplicateKeys.size > 0) findings.push(criticalFinding("PAY-IDEMPOTENCY", "Duplicate idempotency keys block reconciliation.", "Investigate duplicates without moving funds."));
  const total = (type: PaymentEvent["type"]): number => input.events.filter((event) => event.type === type).reduce((sum, event) => sum + event.amountMinor, 0);
  const captured = total("capture");
  const settled = total("settlement");
  const reversed = total("reversal");
  const refunded = total("refund");
  if (captured !== settled + reversed || refunded > settled) findings.push(criticalFinding("PAY-LEDGER", "Synthetic capture, settlement, reversal, and refund evidence does not reconcile.", "Escalate the exception for operator review; do not move funds."));
  if (!input.humanApproval) findings.push(criticalFinding("PAY-APPROVAL", "A payment exception requires operator approval.", "Assign an authorized human reviewer."));
  return {
    findings,
    domain: {
      transactionId: input.transactionId,
      currency: input.currency,
      eventCount: input.events.length,
      timelineSourceIds: input.events.map((event) => event.sourceId),
      capturedMinor: captured,
      settledMinor: settled,
      reversedMinor: reversed,
      refundedMinor: refunded,
      fundsMoved: false,
      fraudDecisionMade: false
    }
  };
}

export const paymentsModule: ScenarioModule<"payments", PaymentsLabInput> = {
  name: "payments",
  parse: parsePayments,
  policy: paymentsPolicy,
  findingIds: paymentsFindingIds,
  envelope: {
    availabilityTarget: "99.9%",
    recoveryTimeObjective: "30 minutes",
    recoveryPointObjective: "5 minutes",
    failurePosture: "Fail closed; preserve immutable event references; never move funds",
    costUnit: "cost per reconciled exception",
    retentionPosture: "Governed record schedule; no PAN, CVV, or account data"
  }
};
