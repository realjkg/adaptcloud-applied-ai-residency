# Tool onboarding

The repository uses one delivery standard across different development environments.

## Claude and Claude Code

Begin with `CLAUDE.md`. Ask Claude to inspect, plan, identify controls, implement a bounded issue, run the gates, and return evidence. CCA-F is the architecture baseline; passing the repository gates is the delivery baseline.

`.claude/skills/` carries that baseline as six executable skills: `cca-f-architecture-review`, `well-architected-review`, `tokenomics-estimate`, `promotion-evidence`, `scenario-policy`, and `residency-gates`. Each wraps a deterministic script over the repository's own policy, so the guidance and the control cannot diverge. They run offline through the `skills:*` npm scripts in any environment, including Cursor and Replit, and `npm run skills:check` verifies the set. Scope is this repository's principles; the skills do not reproduce a certification blueprint.

## Cursor

The rule in `.cursor/rules/adapt-cloud.mdc` loads the engineering constraints. Use Agent mode on one issue at a time. Review every diff and command before acceptance.

## Lovable

Use Lovable only for the resident-facing or customer-demo UI. Connect it to `POST /api/assess` or to a versioned scenario route such as `POST /api/v1/scenarios/payments/assess`; never place an Anthropic key in generated browser code. The UI must label deterministic versus Claude-assisted results, display findings without suppressing severity, and require human review before any follow-up action.

## Replit

Import the repository, add `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` as Secrets only when Claude-assisted mode is required, and run the supplied `.replit` configuration. The sample works without a key. Never paste client data into a shared workspace.
