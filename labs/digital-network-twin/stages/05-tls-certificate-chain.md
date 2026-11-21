---
id: 05
title: TLS certificate chain
vendor: F5 BIG-IP and Cloudflare (trust chain)
requires: inventory.recorded
produces: tls.certificate
---

## Why this comes before the virtual server

HTTPS is terminated at a specific point, and that point needs a certificate and key. The same certificate chain must also satisfy Cloudflare's origin check in stage 08 when Cloudflare is set to validate the origin. Creating the certificate once, here, avoids two chains that almost match.

## Components involved

`f5-self` (where TLS terminates in this twin) and `cf-edge` (which will validate the origin certificate).

## Configure (conceptual)

1. Generate a private key in the approved key store, not on a shared workstation. The key must never be written into the twin file or this repository.
2. Request a certificate for the public hostname (`app.lab.example`) from a publicly trusted CA, or use a Cloudflare Origin CA certificate. Full (strict) accepts only those, unless you configure a custom origin trust store. The subject name must match the hostname that Cloudflare sends to the origin.
3. Import the certificate and intermediate chain into F5 as a certificate object, and the key as the matching key object.
4. Record the expiry date and the renewal owner in the inventory.

## Verify

- The F5 certificate object shows the expected subject, issuer, and expiry.
- The certificate chain validates to the trust anchor you intend.
- The key object exists, but its contents are not printed or exported anywhere.

## If you do it out of order

Stage 06 needs a client SSL profile that references a certificate and key. Stage 08 needs a certificate that Cloudflare can validate. Without this stage, the virtual server cannot be built, and an origin certificate created later often has the wrong subject name, which produces a 526 error at the edge.
