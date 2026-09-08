# Adapt Cloud Applied AI Engineer Residency

A production-shaped learning repository for developers becoming client-ready applied AI engineers. It combines Claude architecture, agentic development, automated testing, AI Tokenomics, cloud operations, security governance, and evidence-backed delivery.

The Vercel surface is intentionally a static engineering walkthrough. It does not deploy infrastructure, invoke Claude, export telemetry, or hold credentials. See `docs/VERCEL_WALKTHROUGH.md` for that boundary.

The included sample agent turns a synthetic client intake into:

- a deterministic token-cost estimate;
- security and governance findings;
- an optional Claude-assisted architecture recommendation; and
- evidence metadata suitable for an engagement review.

Run all three credential-free lab simulations across both cloud contracts:

```bash
npm run lab:simulate
```

This exercises commercial, payments, and insurance deterministic policy behavior for AWS and GCP. Terraform provider mocks validate the real infrastructure plans in CI without accessing an account. Live Claude testing is explicitly opt-in; see `docs/CLOUD_LAB.md`.

## Quick start

```bash
nvm use
npm ci
npm run check
npm test
npm run eval
npm run readiness
npm run agent -- examples/client-intake.json
```

Start the API:

```bash
npm run dev
curl http://localhost:3000/health
curl http://localhost:3000/health/ready
curl -X POST http://localhost:3000/api/assess \
  -H 'content-type: application/json' \
  --data-binary @examples/client-intake.json
```

The workflow defaults to local deterministic mode. To request a Claude recommendation locally, copy `.env.example` to `.env`, supply a model and pricing approved by the fork owner, place the API key in `.env`, and run `npm run dev:env`. The ordinary `npm run dev` command does not load `.env`, and tests never require a key.

After a Vercel deployment, verify that the public surface is static and healthy:

```bash
DEPLOYMENT_URL=https://your-preview.vercel.app npm run smoke:deployment
```

Fork owners must replace repository, identity, cloud, and support values before enabling infrastructure workflows. Students use their own fork, credentials, cloud account, state, registry, telemetry, and billing; the code has no technical dependency on Adapt Cloud. See `docs/FORK_SETUP.md` and `docs/STUDENT_BYOC.md`.

Before handing the repository to a student, complete the clean-room, container, telemetry, Terraform, SBOM, and security gates in `docs/STUDENT_HANDOFF.md`.

The guided promotion lab makes QA a first-class stage and evaluates cumulative evidence from development through production review without authorizing deployment. Run `npm run promotion:simulate -- --environment=all` and follow `docs/ENVIRONMENT_PROMOTION_LAB.md`.

## Dev-to-production path

The same container and runtime contract move from local development to production. Development stays credential-free; production fails closed unless its gateway, managed-secret, immutable-audit, multi-zone, telemetry, cost, autoscaling, infrastructure-as-code, recovery, and rollback controls are declared.

```bash
npm run readiness:production-reference
docker build -t adaptcloud-applied-ai-residency:local .
```

The reference profile contains no secrets and is not a production approval. See `docs/WELL_ARCHITECTED.md` for the six-pillar control map, scenario SLO overlays, platform-adapter contract, promotion gates, and residual obligations; use `docs/RUNBOOK.md` for shared incident, rollback, and restore procedures.

AWS ECS Fargate and GCP Cloud Run application-layer foundations live in `infra/`. Unit tests must pass before either root is validated or planned. A manually triggered GitHub workflow exchanges short-lived OIDC identity from the student's fork: it may apply or destroy only `sandbox`, while `staging` and `production` remain reviewed plans. Use `docs/CLOUD_LAB.md` for the OpenTelemetry and cross-cloud evidence exercise and `infra/README.md` for prerequisites and stop conditions.

## Development environments

- **Claude Code:** governed by `CLAUDE.md`.
- **Cursor:** governed by `.cursor/rules/adapt-cloud.mdc`.
- **Lovable:** builds only the presentation layer against the sample API; secrets remain server-side.
- **Replit:** runs through `.replit`; use Replit Secrets for server-side configuration.

See `docs/TOOLS.md`, `docs/RESIDENCY.md`, `docs/CLIENT_READINESS.md`, `docs/WELL_ARCHITECTED.md`, `SECURITY.md`, and `CONTRIBUTING.md` before beginning.

## First resident assignment

1. Run the current gates and sample assessment.
2. Explain where deterministic policy ends and Claude reasoning begins.
3. Add schema-versioned evidence output without logging prompt content.
4. Add positive, negative, and adversarial tests.
5. Open a pull request using the supplied template.

## Training boundary

Use synthetic data only. This repository is not a compliance certification, production deployment, or authorization to process regulated information.
