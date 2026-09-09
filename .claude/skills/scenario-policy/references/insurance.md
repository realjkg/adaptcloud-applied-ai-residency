# Insurance: first notice of loss and claims evidence

**Shape:** a carrier or claims administrator submits a synthetic policy summary, an FNOL
narrative, incident details, a document manifest with stable source identifiers, claimant facts,
and missing-information indicators. The agent returns a structured intake summary, an evidence map
citing source identifiers, missing-document and contradiction findings, a routing recommendation,
questions for the adjuster or claimant, an uncertainty statement, and adjudication status.

**Implementation:** `insurancePolicy` in `src/labs/simulator.ts`; fixture
`examples/labs/insurance.json`.

## Invariants

- **Never determine** coverage, liability, fault, eligibility, claim value, denial, cancellation,
  premium, or payment. The domain output asserts `coverageDetermined`, `liabilityDetermined`, and
  `paymentAuthorized` are all false.
- **Never infer protected or sensitive characteristics** that were not explicitly and legitimately
  supplied. Inferring them is both a fairness failure and a privacy one.
- **Every material factual statement maps to a source identifier** or is labelled an inference.
  Facts whose `sourceId` is absent from the document manifest are reported as unsupported.
- **Missing evidence stays missing.** The policy lists `missingDocuments`; nothing fills the gap.
- Adverse or consequential recommendations require human adjuster review.
- Logs exclude claim narratives and sensitive personal data (`narrativeLogged: false`).

## Blocking findings

| Id | Raised when | Why it blocks |
|---|---|---|
| `INS-EVIDENCE` | a required document type is absent from the manifest | the gap must stay open and be requested, not reasoned around |
| `INS-PROVENANCE` | a fact cites a source identifier that was not supplied | an unsourced fact in a claim file is indistinguishable from a fabrication |
| `INS-APPROVAL` | `humanApproval` is false | routing a claim needs an authorized adjuster |

## Provenance as the core mechanism

The document manifest defines the set of legitimate source identifiers, and every fact is checked
against it. This is the repository's smallest honest version of RAG provenance: a claim is
admissible only if it points at supplied evidence. It also makes the failure visible — the output
names the unsupported fact rather than silently dropping or accepting it.

Uncertainty is reported, not resolved. An intake with three missing documents and two
contradictions is a *useful* output when it says so precisely; it becomes a liability the moment
it reads as complete.

## Operating envelope

99.5% availability, 4-hour RTO, 1-hour RPO. Failure posture: preserve provenance and missing
evidence; human adjudication only. Cost unit: **cost per reviewed intake**. Retention: policy-
and jurisdiction-approved schedule, with narratives excluded from logs.

## Extending safely

Document ingestion, extraction, or retrieval must preserve stable source identifiers end to end —
provenance that breaks during extraction is worse than no extraction, because the citation still
looks valid. Any capability that touches adjudication, valuation, or claimant communication
crosses the action boundary and needs explicit human approval and tests first.
