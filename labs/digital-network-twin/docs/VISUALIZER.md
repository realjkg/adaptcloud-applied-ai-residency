# Topology visualizer

A browser tool that draws the twin's topology and captures a point-in-time view. It is not a command-line tool: the
npm scripts only build the sample data and serve the files locally.

## What is built

| Piece | Where | State |
|---|---|---|
| Static viewer (draws, filters, compares, captures) | `viewer/` | Built and tested |
| Snapshot contract v1 and validator | `viewer/snapshot.js` | Built and tested |
| Synthetic snapshots (a build that grows, then a proposed change) | `snapshots/`, `tools/snapshot.mjs` | Built; `npm run snapshot` regenerates them |
| Local dev server (127.0.0.1, GET only) | `viewer/serve.mjs` | Built and tested |
| Collector that reads vendor admin and account APIs | none | Not built |
| Sign-in, roles, snapshot storage, scheduling | none | Not built |
| Any control that changes a vendor | none | Not built, by design |

Run it with `npm run snapshot && npm run viewer`, then open the address printed.

## Hosting: Vercel or Cursor

They do different jobs, so they are not alternatives. Cursor is an editor for writing the code. Vercel hosts it.

- The **viewer** is static files. It can be hosted on Vercel, any static host, or the customer's own web server.
- The **collector**, the part that holds credentials and calls vendor APIs, should run inside the customer's
  environment. Palo Alto and F5 management planes are normally private, and Vercel reaches private networks only
  through Secure Compute (Enterprise plan) or fixed egress addresses that the customer allowlists. Confirm current
  terms with Vercel before relying on either.
- The repository's Vercel boundary forbids credentials and write actions. The viewer respects that: it holds no
  credentials and calls nothing but its own origin.

```
vendor APIs (read-only) -> collector (customer environment) -> snapshot store -> static viewer (any host)
```

## Snapshot contract

One snapshot is one point in time. Fields: `schemaVersion`, `snapshotId`, `capturedAt`, `label`, `synthetic`,
`source` (`kind`, `access` actually used, `plannedAccess` recommended), `configDigest`, `topologyDigest`, and
`topology` (`groups`, `nodes`, `edges`). Limits are in `viewer/snapshot.js`. A collector produces this shape and the
viewer needs no other change.

Snapshot content is untrusted. The viewer validates it before drawing, checks the digest, writes every string with
`textContent` or `setAttribute`, and runs under a CSP with no inline script or style. A mismatched digest is shown,
not hidden.

## Admin-level and account-level access

The viewer shows, per vendor, the read-only access a collector would use. These are recommendations to confirm per
platform. Nothing was called.

| Vendor | Level | Mode |
|---|---|---|
| Meraki | Organization read-only administrator, a dedicated account | read-only |
| Palo Alto | Firewall or Panorama administrator with a read-only role | read-only |
| F5 | BIG-IP user with a read-only role | read-only |
| Cloudflare | Account API token with read permissions on the zone | read-only |

The panel reads "No live API was called" for synthetic snapshots, and lists `source.access` once a collector fills it.
"Visual controls" in this slice are viewing controls: snapshot and baseline selection, vendor filter, findings only,
search, zoom, and capture. A "Request a change" control exists and is disabled. Changes go through the guarded
provisioning gate (`docs/PROVISIONING.md`), not through the viewer.

## Point-in-time capture

- **SVG**: self-contained, no CSS or script. It carries a footer (snapshot, capture time, digest, source, synthetic
  flag, render time) and a `<metadata>` block with the same facts.
- **PNG**: rendered from that SVG in the browser.
- **JSON**: the snapshot exactly as loaded.
- **Compare**: pick an earlier snapshot to outline additions and count changes.

A capture states when the state was true and when it was drawn, and those can differ.

## Not yet decided

1. Where the vendor APIs are reachable from, and which host runs the collector.
2. Whether read-only API identities are permitted for each platform.
3. Snapshot retention, storage location, and schedule.
4. Sign-in and role needs (SSO, who may see which vendor).

## Roadmap

1. Collector with a read-only adapter per vendor, behind the same guarded HTTP client as provisioning.
2. Snapshot store with immutable, content-addressed files in the customer's storage.
3. Sign-in and role-based visibility.
4. Scheduled capture and drift alerts against the as-built requirements.

Rollback: delete `viewer/`, `snapshots/`, `tools/snapshot.mjs`, `test/viewer.test.mjs`, and this file. Nothing else
depends on them.
