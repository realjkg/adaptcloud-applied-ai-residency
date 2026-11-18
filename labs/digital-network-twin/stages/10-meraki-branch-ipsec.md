---
id: 10
title: Meraki branch IPsec tunnel to the NGFW hub
vendor: Cisco Meraki (MX) and Palo Alto Networks (NGFW hub)
requires: addressing.plan, pa.interfaces
produces: pa.ipsec-hub, meraki.spoke-up
---

## Why the tunnel is not Auto VPN

Cisco Meraki Auto VPN connects Meraki MX appliances to each other. The data center hub here is a Palo Alto NGFW, so the branch MX connects to it as a standard site-to-site IPsec peer. Choosing the right mechanism is part of the architecture, and this stage is where that choice shows up in configuration.

## Components involved

`mx-branch` (Meraki MX at the branch, WAN 198.51.100.40, LAN 10.40.0.0/24) and `pa-untrust` (the NGFW hub). The tunnel terminates on the NGFW and is placed in the `vpn-branch` zone.

## Configure (conceptual)

1. On the NGFW, create an IKE gateway and IPsec tunnel interface using the untrust interface and the peer address `198.51.100.40`. Place the tunnel interface in the `vpn-branch` zone.
2. Use IKEv2 with a strong pre-shared key or certificate authentication. The key is stored in the approved secret store, not in this repository or the twin file.
3. On the Meraki MX, configure a non-Meraki VPN peer to the NGFW hub's address, with the same IKE and IPsec parameters and the branch LAN as the local network and `10.20.0.0/24` and `10.30.0.0/24` as remote networks.
4. Confirm that the MX lists the tunnel as up and that the NGFW shows an IKE security association for the branch.

## Verify

- Both sides report the tunnel as established, and the traffic counters increase when a test packet crosses.
- A dead-peer or rekey test succeeds: the tunnel reconnects after a short outage.
- Routes exist on both sides for the remote networks only, not for `any`.

## If you do it out of order

Stage 11 needs a live path from the branch to the NGFW. If the tunnel is built after the branch policy, the policy references a `vpn-branch` zone that carries no traffic, and the team spends time chasing a policy problem that is really a tunnel problem. The twin refuses stage 10 until the NGFW's untrust interface exists.
