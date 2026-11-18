---
id: 08
title: Cloudflare DNS and proxy
vendor: Cloudflare
requires: pa.policy.edge-https, tls.certificate
produces: cf.proxy-enabled
---

## Why this comes after the policy

Turning on the proxy sends real user traffic to the origin. The NGFW must already allow Cloudflare's addresses on port 443, and the origin must already present a certificate that Cloudflare can validate. Until both are true, enabling the proxy only creates errors for users.

## Components involved

`cf-edge` (the Cloudflare zone and its DNS record), the origin at `198.51.100.2` (NGFW untrust), and the certificate from stage 05.

## Configure (conceptual)

1. Create the DNS record for the application hostname as an address record pointing to the origin, `198.51.100.2`, with the proxy enabled. In the Cloudflare dashboard this is the orange-cloud setting.
2. Set the SSL/TLS encryption mode to **Full (strict)**. Strict mode checks that the origin certificate matches the hostname and is trusted, which is why stage 05 mattered.
3. Enable Authenticated Origin Pulls, if the origin is configured to require the Cloudflare client certificate, and record where that certificate is stored.
4. Keep the DNS TTL low during the change so that a rollback takes effect quickly.

## Verify

- `dig` against the public resolver returns Cloudflare addresses for the hostname, not the origin address. Proxy resolution is the signal that traffic is going through the edge.
- A request to the hostname returns 200 from the application, with a Cloudflare response header present.
- A certificate error at the edge (error 526) means the origin certificate failed strict validation: go back to stage 05.

## If you do it out of order

Proxying before stage 07 means the edge reaches an origin that the NGFW blocks, and users see 502 or 522 errors. Choosing Full instead of Full (strict) before stage 05 hides a bad certificate until a security review finds it. The twin refuses stage 08 until the policy and certificate exist.
