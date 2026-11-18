---
id: 07
title: Palo Alto security policy
vendor: Palo Alto Networks (PA-Series NGFW)
requires: pa.zones, f5.vip
produces: pa.policy.edge-https, pa.policy.branch-https, pa.policy.default-deny
---

## Why policy comes after the delivery point

Security rules name a destination. A rule that allows `10.20.0.100:443` is meaningful only after that address exists. Writing the rule first either forces a placeholder address that later has to be changed, or allows a broader destination than intended. This stage is also where the NGFW's behavior is decided, so it is the stage most worth reviewing line by line.

## Components involved

`pa-untrust`, `pa-dmz`, the `vpn-branch` zone, `f5-vip`, and the Cloudflare origin entries.

## Configure (conceptual)

Palo Alto security rules are evaluated from the top down, and the first match wins. Order is part of the policy.

1. **Edge HTTPS (internet to VIP).** Source: an address object named `cloudflare-ranges`, populated from Cloudflare's published IP list, not typed by hand. Destination: `f5-vip`. Service: TCP 443. Action: allow, with logging on. Pair it with destination NAT from `198.51.100.2:443` to `10.20.0.100:443`.
2. **Branch HTTPS (VPN to VIP).** Source: `10.40.0.0/24` from zone `vpn-branch`. Destination: `f5-vip`. Service: TCP 443. Action: allow, with logging on.
3. **Default deny.** Source: any. Destination: any. Action: deny, with logging on. This rule is last, so every flow not matched above is denied and recorded.
4. Attach a security profile (threat prevention and URL filtering) to the allow rules. Do not attach profiles to the deny rule.

## Verify

- A connection from a Cloudflare source address to `198.51.100.2:443` reaches the VIP and is logged as allowed.
- A connection from an address outside the Cloudflare list to the same port is denied.
- A connection from the branch subnet to the VIP is allowed; a connection from the branch to `10.30.0.0/24` directly is denied.
- The default-deny rule's hit count increases when you test a disallowed port.

## If you do it out of order

If the allow rules are written before the VIP exists, they name a placeholder address. If the default-deny rule is placed above the allow rules, every flow is denied and the team concludes that the F5 is broken. If the source list is typed by hand and goes stale, the origin gets blocked when Cloudflare changes its ranges. The twin refuses stage 07 until `f5.vip` and the zones exist.
