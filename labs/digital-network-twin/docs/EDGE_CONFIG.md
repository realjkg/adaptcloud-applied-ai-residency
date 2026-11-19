# Cloudflare edge configuration

Edge behavior (WAF custom rules, redirects, cache rules) changes through the Cloudflare **Rulesets API**. This integration plugs into the same target-based workflow as Palo Alto and Meraki: an allowlisted target alias, a dry-run diff, a different approver, re-checks just before the write, read-back, and a separately approved rollback.

Request shapes were taken from the Cloudflare documentation, read through the Cloudflare documentation connector: phase entry point read (`GET /zones/{zone}/rulesets/phases/{phase}/entrypoint`, 404 when the phase has none), single-rule add (`POST .../rulesets/{id}/rules`, appended, the reply is the whole ruleset, the version increments), single-rule delete (`DELETE .../rules/{rule id}`), and one `POST .../rulesets` that creates the entry point with the rule inside. The adapter is not tested against a real zone.

## Why this fits edge changes

A single-rule add or delete never rewrites the other rules, so another administrator's rule cannot be overwritten, and no exclusive change window is required (Meraki needs one). A concurrent edit during the write is still possible; the read-back compares the rules and reports a difference as uncertain, with no automatic repair.

## First scope

| Change type | Phase | Notes |
|---|---|---|
| `waf-custom-rule.add` | `http_request_firewall_custom` | block, managed_challenge, js_challenge, or log. No execute or skip actions. |
| `redirect-rule.add` | `http_request_dynamic_redirect` | static https target, status 301/302/307/308, optional query preservation |
| `cache-rule.add` | `http_request_cache_settings` | bypass cache, or eligible with an optional edge TTL |
| `edge-rule.remove` | any of the three | rollback only; refused unless the rule is exactly what this system added |

The browser never supplies an expression. It supplies one condition from closed lists (host, path, country, or IP; with the operators each allows), and the server builds the expression from validated parts. Values cannot contain quotes, backslashes, or spaces, so there is no escaping to get wrong. Rules carry a `ref` (`twin-<operation id>`) and a description mark so a rollback can only touch what this system created.

## Synthetic traffic preview

The plan shows how many of 20 fixed synthetic requests the new rule would match and what it would do to them. It is not real traffic, and existing rules are not evaluated; the plan says so.

## Live settings

A live target needs `host: api.cloudflare.com`, a 32-hex `zoneId` and `accountId`, a `zoneName` that is not a placeholder (`.example`, `.test`, `example.com`, `localhost` are refused), `credentialEnv` naming an environment variable that holds an API token, and an access list. Before staging, and again at execution, the adapter reads the zone and requires the same name and account. Token permissions follow the documentation (for example Zone WAF Edit, Cache Rules Edit, Dynamic URL Redirects Edit). Governed by `docs/adr/0002-per-execution-authorization.md`.

## Not built

Rule update and reorder, rate limiting, managed-ruleset deployment and exceptions, transform rules, account-level rulesets, DNS and zone settings through this path (DNS records stay in the older config-change path), and any use of Cloudflare Workers, KV, or other developer-platform resources. Zone response shapes (`GET /zones/{id}`) were not confirmed in the documentation read.
