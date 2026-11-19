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
| draw.io export (Lucidchart and Visio through draw.io) | `viewer/drawio.js`, `tools/export-drawio.mjs` | Built and tested; not opened in those tools |
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

### Vercel, Lovable, or Cursor, with REST or a graph database

| | What it is | REST APIs | Graph database |
|---|---|---|---|
| Cursor | An editor for writing code. It hosts nothing. | Not applicable | Not applicable |
| Vercel | Hosting for static files and serverless functions | A function can call any REST API it can reach | None built in. A function can call a graph database's HTTP API, if the database is reachable from Vercel |
| Lovable | An app builder with its own stack: React with a Postgres backend (Supabase), auth, and edge functions | Edge functions can call REST APIs | None built in. Postgres is its native store |

All three can call REST. None runs a graph database, so a graph store would be separate, and it would face the same
reachability limit as the vendor APIs. At this scale a snapshot is already a small graph (nodes, edges, groups) and
needs no graph database. Revisit one if queries across many snapshots, such as "every path into the app zone over the last
year", become routine. Recommendation: Vercel or any static host for the viewer, the collector inside the customer's
environment, and Cursor to write it. Lovable generates its own stack, which would have to be re-checked against this
repository's boundaries, so it fits a throwaway prototype better than this product.

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

## Export to draw.io, Lucidchart, and Visio

"Export for draw.io, Lucidchart, Visio" (or `npm run drawio -- --snapshot=snapshots/SYNTH-SNAP-004.json --out=x.drawio`)
writes an editable diagrams.net file. Each element, connection, and group is a real shape that carries its vendor,
config path, snapshot ID, and digest as data. Open it in draw.io; Lucidchart imports draw.io files; draw.io exports
Visio (.vsdx). This was checked as well-formed XML with consistent references. It has not been opened in draw.io,
Lucidchart, or Visio.

It uses draw.io's built-in shapes, so it does not yet look like vendor stencils (Cisco, Palo Alto, F5 icons). Adding
them means choosing a stencil per element type and confirming each name in draw.io.

"Terraform to Visio" is not built. Terraform here is generated from the same config as the diagram
(`tools/render-iac.mjs`), so config to Terraform and config to diagram agree. Reading arbitrary Terraform into a
diagram would need a parser or plan-JSON reader and a resource-to-shape table per provider.

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
