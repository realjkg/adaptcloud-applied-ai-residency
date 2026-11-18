---
id: 11
title: Branch policy and routing
vendor: Cisco Meraki (MX), Palo Alto Networks, F5 BIG-IP
requires: meraki.spoke-up, pa.policy.branch-https, f5.vip
produces: branch.path-permitted
---

## Why this comes after the tunnel and policy

The branch is a trusted site, but it still crosses the NGFW and then the F5 to reach the application. Routing and policy must be consistent on both ends of the tunnel. If the branch routes a flow into the tunnel and the NGFW has no matching allow rule, the traffic is dropped without an obvious reason.

## Components involved

`mx-branch` (branch routes and MX firewall rules), `pa-dmz` and `vpn-branch` (NGFW zones and rules from stage 07), and `f5-vip` (the destination).

## Configure (conceptual)

1. On the MX, route traffic for `10.20.0.100/32` through the non-Meraki VPN peer. Do not route the whole `10.0.0.0/8` into the tunnel.
2. On the MX firewall, allow outbound TCP 443 from the branch LAN to `10.20.0.100`, and deny other traffic to the data center networks.
3. Confirm that the NGFW's branch rule from stage 07 matches the same source and destination. A mismatch here is the most common failure in this design.
4. Keep return routes symmetric: the NGFW must route `10.40.0.0/24` back through `vpn-branch`.

## Verify

- From a branch test client, `https://10.20.0.100` returns the application response through the tunnel.
- The NGFW log shows the flow matching the branch rule, with the expected zones.
- A test to `10.30.0.11` directly from the branch is denied, which proves the F5 is the only path to the pool.

## If you do it out of order

Without the tunnel, the branch route points at nothing. Without the NGFW branch rule, the flow is denied by default. Without the F5 VIP, there is no destination to test against. The twin refuses stage 11 until all three inputs exist.
