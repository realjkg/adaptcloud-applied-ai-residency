# Fork setup

This repository is safe to inspect and run locally with synthetic data. A fork does not inherit Adapt Cloud authorization, cloud trust, production evidence, or permission to process regulated information.

## 1. Repository identity

- Replace Adapt Cloud names and links where the fork represents another organization.
- Replace `@realjkg` in `.github/CODEOWNERS` with accountable maintainers.
- Configure a private vulnerability-reporting route in `SECURITY.md`.
- Keep the synthetic-data and human-approval boundaries unless an approved governance review replaces them.

## 2. Local runtime

Use Node 22 and the lockfile:

```bash
nvm use
npm ci
npm run check
npm test
npm run eval
```

The deterministic path needs no secrets. For optional Claude-assisted local execution, copy `.env.example` to `.env`, set an approved model, pricing, and API key, then run `npm run dev:env`. Never commit `.env`.

## 3. Vercel walkthrough

Import the repository root with these settings:

| Setting | Value |
|---|---|
| Framework Preset | Other |
| Root Directory | repository root |
| Build Command | blank |
| Output Directory | `public` |
| Development Command | blank |
| Environment variables | none |

The committed `vercel.json` forces the same static boundary. A correct deployment lists static assets and no function for `/`. Verify every candidate deployment before assigning a production domain:

```bash
DEPLOYMENT_URL=https://your-preview.vercel.app npm run smoke:deployment
```

## 4. GitHub controls

- Protect `main` with pull requests, review, resolved conversations, and required quality checks.
- Enable Dependabot, secret scanning, push protection, private vulnerability reporting, and code scanning where available.
- Create the `infrastructure-plan` environment with a required reviewer and protected branches.
- Restrict cloud OIDC trust to the fork's exact repository, approved ref, and `infrastructure-plan` environment.
- Review and replace action version pins under the fork owner's supply-chain policy.

## 5. Cloud values

Use `infra/README.md` as the authoritative variable list. Replace every example account, project, role, service account, network, registry, state, collector, gateway, budget, and region value. Keep images digest-pinned and credentials out of repository variables and Terraform state.

The included workflow creates plans only. It cannot apply or destroy infrastructure. A platform owner must provide remote state, trusted ingress, managed secrets, telemetry destinations, recovery evidence, and a separately controlled promotion path.

## Acceptance evidence

A fork is ready for another engineer only when:

1. a clean clone passes all local gates on Node 22;
2. deterministic execution works without credentials;
3. the Vercel smoke check proves a static page rather than a function;
4. repository ownership and security reporting point to the fork owner; and
5. any cloud plan uses the fork's short-lived OIDC identity and contains no unexpected mutation, public ingress, secret, or mutable image tag.
