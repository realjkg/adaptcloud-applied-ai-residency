# Vercel walkthrough boundary

Vercel hosts only the static resident-facing walkthrough in `public/`. It does not run the long-lived sample server, export telemetry, call Claude, store credentials, provision infrastructure, or execute a deployment command.

The page lets an engineer select one of the three scenarios, walk through the evidence sequence, and inspect an OpenTelemetry-shaped synthetic span. The preview exists to teach resource, span, attribute, event, and control concepts before a real exporter is introduced.

## Hosting contract

- `vercel.json` runs the ordinary TypeScript build and serves `public/`.
- Node is pinned to the same major version used by the container and CI.
- Browser assets are committed, deterministic, and dependency-free.
- Content Security Policy prevents external scripts and network connections.
- No API route, model key, OTLP endpoint, cloud credential, or write-capable action exists in the Vercel surface.

## Local preview

Run the repository gates, then serve the static directory with any local static server:

```bash
npm ci
npm run build
npm test
npx serve public
```

The `npx serve` command is for local convenience and is not part of the build or production dependency set.

## Future OpenTelemetry lab

A later bounded change may add a local OpenTelemetry Collector and trace backend through an opt-in development Compose profile. That lab must keep synthetic data, bind collector ports to localhost, disable external export by default, and remain separate from the Vercel page. The browser should visualize sanitized lab output through a read-only adapter rather than receive an OTLP credential.
