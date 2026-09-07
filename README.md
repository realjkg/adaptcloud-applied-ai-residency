# Adapt Cloud Applied AI Engineer Residency

A production-shaped learning repository for developers becoming client-ready applied AI engineers. It combines Claude architecture, agentic development, automated testing, AI Tokenomics, cloud operations, security governance, and evidence-backed delivery.

The included sample agent turns a synthetic client intake into:

- a deterministic token-cost estimate;
- security and governance findings;
- an optional Claude-assisted architecture recommendation; and
- evidence metadata suitable for an engagement review.

## Quick start

```bash
npm install
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

The workflow defaults to local deterministic mode. To request a Claude recommendation, copy `.env.example` to `.env`, supply the model and pricing currently approved by Adapt Cloud, and place the API key in the environment or platform secret manager. The program does not load `.env` automatically and never requires a key for tests.

## Dev-to-production path

The same container and runtime contract move from local development to production. Development stays credential-free; production fails closed unless its gateway, managed-secret, immutable-audit, multi-zone, telemetry, cost, autoscaling, infrastructure-as-code, recovery, and rollback controls are declared.

```bash
npm run readiness:production-reference
docker build -t adaptcloud-applied-ai-residency:local .
```

The reference profile contains no secrets and is not a production approval. See `docs/WELL_ARCHITECTED.md` for the six-pillar control map, scenario SLO overlays, platform-adapter contract, promotion gates, and residual obligations; use `docs/RUNBOOK.md` for shared incident, rollback, and restore procedures.

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
