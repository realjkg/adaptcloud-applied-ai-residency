---
id: 01
title: Addressing and inventory
vendor: all
requires: none
produces: addressing.plan, inventory.recorded
---

## Why this comes first

Every later stage refers to an address, a zone, or a device name. If those are decided after configuration starts, each device gets a different idea of the network. Decide the plan once, write it down, and let every later stage cite it.

## Components involved

All four vendors, plus the synthetic application servers. No device is configured yet.

## Configure (conceptual)

Record one row per component: name, vendor, role, zone, interface addresses, and the owner who approves changes to it.

| Component | Vendor | Zone | Address |
|---|---|---|---|
| `cf-edge` | Cloudflare | internet (public DNS) | published origin name only |
| `pa-untrust` | Palo Alto NGFW | untrust | 198.51.100.2/24 |
| `pa-dmz` | Palo Alto NGFW | dmz | 10.20.0.2/24 |
| `f5-self` | F5 BIG-IP | dmz | 10.20.0.10/24 |
| `f5-vip` | F5 BIG-IP | dmz | 10.20.0.100 (virtual server) |
| `app-01`, `app-02` | synthetic app | app | 10.30.0.11, 10.30.0.12 |
| `panorama` | Palo Alto Panorama | management | 10.99.0.5/24 |
| `mx-branch` | Cisco Meraki MX | branch WAN / LAN | 198.51.100.40 / 10.40.0.1/24 |

Use only RFC 5737 and RFC 1918 ranges in this lab. Record the names of the zones too: `untrust`, `dmz`, `app`, `management`, `vpn-branch`.

## Verify

- Every address appears exactly once in the table.
- Every later stage names only components that appear here.
- Each zone has at least one interface or tunnel assigned to it in the plan.

## If you do it out of order

Stage 03 cannot assign interfaces to zones, and stage 06 cannot point the virtual server at a pool. The twin refuses those stages because `addressing.plan` is missing, which is the same failure you would see when an engineer configures a device from memory.
