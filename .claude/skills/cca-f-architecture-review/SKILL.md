---
name: cca-f-architecture-review
description: Review or design an agent architecture against this repository's trust boundaries — where untrusted intake enters, where deterministic control ends and model reasoning begins, and where a human must approve. Use this whenever someone proposes adding a tool, capability, endpoint, integration, or model call; asks whether a design is safe, sound, or client-ready; asks where Claude's authority stops; or is preparing an architecture answer for a CCA-F-style review. Also use before writing code that touches src/agent/, the model adapter, or anything that reads intake data.
---

# Architecture review against the trust boundary

The one architectural idea this repository teaches: **the model advises, deterministic code decides.** Every control in `src/` exists to keep that true under pressure — bad input, a hostile prompt, a provider outage, a plausible-sounding model answer. An architecture review here is not a style opinion. It asks a specific question of every change: *which boundary does this cross, and what holds the line when it does?*

## Start with the scan, not with reading code

```bash
node .claude/skills/cca-f-architecture-review/scripts/scan-boundaries.mjs
```

Nine rules encode crossings that `SECURITY.md`, `docs/ARCHITECTURE.md`, and `CLAUDE.md` prohibit — a credential read outside the model adapter, model output assigned to a severity or approval, intake interpolated into a system prompt, egress outside the reviewed call, pricing hardcoded, prompt bodies in logs. Add `--json` for machine-readable output, `--paths=src,public` to narrow.

The scan is a floor, not a verdict. It finds textual crossings; it cannot tell you a design is sound. A clean scan and a bad architecture coexist easily. Treat findings as the start of the review and the reference below as the rest of it.

## The five boundaries

Read `references/trust-boundaries.md` for the full map with the code that enforces each one. In short, work through a change by asking where it sits:

1. **Intake boundary** — untrusted data enters. Validate and bound it (`src/agent/validate.ts`); never let it reach a system prompt or change what tools exist.
2. **Decision boundary** — deterministic policy runs *before* inference and cannot be overridden by it. Authorization, pricing, validation, and policy are code (`CLAUDE.md` rule 5). If a model answer can flip an outcome, the boundary has moved.
3. **Model boundary** — one adapter (`src/agent/claude.ts`), one credential reader, bounded timeout, retry, and output, and a deterministic fallback on any failure. Failure must degrade capability, never a control.
4. **Action boundary** — the system drafts; a human commits. Read-only by default; a write-capable tool needs explicit human approval and tests (`CLAUDE.md` rule 3).
5. **Evidence boundary** — metadata, control outcomes, and model identity are recorded; prompt bodies and sensitive content are not.

## Reviewing a proposed change

State the boundary crossed, the control that holds, and what happens when the control fails. A review that cannot name the failure mode has not been done.

For anything new, answer these before writing code — they are the questions a client's architect asks, and the ones a CCA-F-style review probes:

- What is the smallest capability that satisfies the need? Read-only if at all possible.
- What is deterministic here, and why is the rest safe to leave to the model?
- What does the system do when the model is wrong, slow, unavailable, or manipulated?
- Who approves, on what evidence, and what does the record show afterward?
- What is the blast radius if this is wrong, and how is it reversed?

When a proposal genuinely needs a boundary crossing, say so plainly and name the compensating control. Refusing every crossing is not architecture either — the judgement is what makes it a design.

## Where this stops

Consequential changes — a write-capable tool, an external connector, a new egress path, anything that would let the system act rather than recommend — need explicit human approval before implementation, not after. Bring the design and the failure analysis; do not bring a finished branch.

## CCA-F domain

Bounded agency and trust-boundary design. This skill is the architecture baseline the residency assumes in `docs/RESIDENCY.md` weeks 1–2 and `docs/TOOLS.md`, expressed as reviewable checks against this repository's own controls.
