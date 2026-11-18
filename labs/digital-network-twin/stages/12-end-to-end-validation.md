---
id: 12
title: End-to-end validation
vendor: all
requires: cf.waf-managed, origin.locked-to-cloudflare, branch.path-permitted, pa.policy.default-deny
produces: validation.passed
---

## Why validation is its own stage

Each earlier stage checked only its own component. This stage proves the whole sequence works together: the internet path, the branch path, and the deny-by-default posture. It is also the stage that a reviewer should read first, because it states what the design claims.

## Components involved

All components in the reference twin.

## Procedure

Run these checks in order and record the result of each.

1. **Public path.** A request to the application hostname returns 200, passes the Cloudflare WAF, and appears in the NGFW log as an allowed Cloudflare-sourced flow to the VIP.
2. **Origin lock.** A direct request to the origin address from outside Cloudflare's ranges is denied.
3. **Branch path.** A request from a branch test client to the VIP returns 200 through the IPsec tunnel.
4. **Pool isolation.** A request from the branch or the internet to a pool member directly is denied.
5. **Management isolation.** A request from outside the administrator network to the management address is denied on every port.
6. **Default deny.** A test to an unlisted port on the VIP is denied and logged by the default-deny rule.
7. **Failure drill.** Stop one application member. Confirm the monitor removes it, traffic continues on the other member, and the event is recorded.

## Verify

The twin is accepted only when every check above passes in the same run, and the results are written into the evidence pack (see the README). A single failed check blocks acceptance, even if the others pass.

## Rollback

Each stage can be reverted in the reverse of the planned order. Revert stage 11 first, then 10, and so on, so that no stage is left depending on something that no longer exists.

## If you do it out of order

Running this stage before the others fails immediately, with the list of facts it is missing. That is the point of the exercise: a test that runs too early tells you about the missing component, not about the design.
