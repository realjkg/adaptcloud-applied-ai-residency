---
id: 09
title: Cloudflare WAF and origin lock
vendor: Cloudflare
requires: cf.proxy-enabled
produces: cf.waf-managed, origin.locked-to-cloudflare
---

## Why this is a separate stage

The proxy alone does not protect the origin. Anyone who learns the origin address can bypass Cloudflare and talk to the NGFW directly. Locking the origin to the edge closes that path, and the WAF then inspects everything that does arrive. These are two different controls, so they get two checks.

## Components involved

`cf-edge` (WAF and managed rules), `pa-untrust` (origin address), and the `cloudflare-ranges` object from stage 07.

## Configure (conceptual)

1. Enable the Cloudflare managed WAF ruleset in block mode for the zone, and review its sensitivity before enforcing. Start in log-only mode for a short period, then switch to block.
2. Use Authenticated Origin Pulls or the NGFW allowlist from stage 07 to make the origin accept traffic only from Cloudflare. Use both if the design needs defense in depth.
3. Confirm that the origin's direct address refuses connections from outside Cloudflare's ranges.
4. Document the rule ordering: the Cloudflare WAF runs first, and the NGFW's deny rule stays last.

## Verify

- A request to the hostname with a known malicious test pattern (a harmless synthetic string the ruleset flags) is blocked at the edge.
- A direct request to `198.51.100.2:443` from outside Cloudflare's ranges is denied by the NGFW and logged.
- Normal application requests through the hostname still return 200.

## If you do it out of order

If the origin is not locked before the proxy goes live, the WAF can be bypassed by anyone who finds the origin address. If the WAF is enabled in block mode before tuning, legitimate users are blocked. The twin refuses stage 09 until the proxy is enabled.
