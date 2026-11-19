# Control plane

The service behind the browser tool: a collector that reads vendor APIs, single sign-on with roles, snapshot storage
and scheduling, and write controls. Start the simulator with `npm run control` and open the printed address.

```
browser (viewer + operate panel)
   | HTTPS, session cookie, CSRF token
control-plane service  -- sign-in (OIDC) -- roles -- audit log (hash-chained)
   |-- scheduler -> collector (GET only, guarded HTTP) -> snapshot -> store (content-addressed, immutable)
   '-- change workflow -> guarded provisioning gate -> transport (simulator, or live adapters)
```

## Status

All of it is exercised against fakes: a simulated tenant, fake vendor responses, and a local identity provider that
signs tokens with a test key. **None of it has run against a real vendor or identity provider.** Live mode is refused
without the settings below. Palo Alto and Meraki have read-only collectors but no write adapters.

| Piece | Where | Real systems |
|---|---|---|
| Collector (Cloudflare, F5, Palo Alto, Meraki; GET only) | `tools/collect/` | Untested |
| OpenID Connect sign-in, PKCE, ID-token verification | `server/oidc.mjs` | Untested against a real provider |
| Roles from provider groups; deny by default | `server/roles.mjs` | n/a |
| Sessions: idle and absolute timeout, CSRF | `server/sessions.mjs` | n/a |
| Snapshot store with holds and retention | `server/store.mjs` | Local directory only |
| Scheduler with overlap guard and pause on repeated failure | `server/scheduler.mjs` | n/a |
| Hash-chained audit log | `server/audit.mjs` | n/a |
| Change workflow (request, approve, execute) | `server/changes.mjs` | Simulator for all four vendors; live for Cloudflare DNS and F5 only |
| HTTP API and browser panels | `server/app.mjs`, `viewer/operate.js` | n/a |

## Roles

| Role | May |
|---|---|
| viewer | read snapshots and changes |
| operator | also collect now, request changes, execute an approved change |
| approver | approve or reject a change, read the audit log |
| admin | schedule, hold, kill switch, collect, request, execute, read the audit log |

Roles come from the identity provider's group claim through an exact mapping in settings (`groupRoles`). A person with
no mapped group has no access. Nobody approves a change they requested, including an admin who is also an approver.
Roles are checked on the server for every action. The browser only hides buttons.

## Write controls

A control is one object type at one vendor, such as `f5/pool` or `paloalto/security-rule` (`GET /api/controls` lists
them). A request names controls, an action (apply or remove), and optionally a proposed config. Then:

1. The health gate runs on the config, so an unhealthy config is refused.
2. A dry run reads current state and records a digest.
3. A different approver approves exactly that digest. The approval expires after 24 hours.
4. The operator executes. The gate checks policy, digest, approval, and current state, writes each object, reads it
   back, and rolls back what the run created on any failure. It never deletes what the twin does not own.

Simulator mode covers every vendor and object. Live mode covers Cloudflare DNS records and four F5 object kinds, behind
the recorded authorization (`docs/adr/0001-live-provisioning-authorization.md`). Writing to Palo Alto and Meraki live
is not built: see `tools/live/transport.mjs` for what blocks each.

## Live settings

`node server/main.mjs --live=settings.json` needs: an `https` `origin`, `dataDir`, `baselinePath`, `tenantId`, `oidc`
(issuer, endpoints, `clientId`, optional `clientSecretEnv`, `groupsClaim`), `groupRoles`, a provisioning `policy` with
the recorded authorization and exact host allowlists, and a `collector` with `enabled`, `acknowledgesUntested`, and
per-vendor `hosts` plus identifiers. Vendor credentials come from the environment: `CLOUDFLARE_API_TOKEN`,
`BIGIP_USERNAME`, `BIGIP_PASSWORD`, `PANOS_API_KEY`, `MERAKI_API_KEY`. Put a TLS-terminating proxy in front; the service
binds to 127.0.0.1. Run it inside the customer's network, not on a public host.

## Known limits

- Pending change requests live in memory and are lost on restart. The audit log is durable.
- Sessions are in memory, so one instance only and a restart signs everyone out.
- No sign-in rate limiting, no refresh of provider keys beyond a ten-minute cache, no group-claim paging.
- The Meraki collector needs the regional host in `hosts`; the guarded client does not follow redirects.
- The snapshot store is a local directory. Object storage with write-once retention would implement the same methods.
- Collector response shapes follow `docs/API_NOTES.md` and are unverified against live devices. The F5 collector does
  not read monitors or client SSL profiles, and the Palo Alto collector reads the first member of each list.

Rollback: delete `server/`, `tools/collect/`, `viewer/operate.js`, the two test files, and this file, and restore the
"Change" section of `viewer/index.html`.
