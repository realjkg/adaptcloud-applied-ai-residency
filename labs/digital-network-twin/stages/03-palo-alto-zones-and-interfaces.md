---
id: 03
title: Palo Alto zones and interfaces
vendor: Palo Alto Networks (PA-Series NGFW)
requires: addressing.plan, mgmt.access-restricted
produces: pa.zones, pa.interfaces
---

## Why this comes here

Security policy on a Palo Alto NGFW is written between zones, not between interfaces. Zones and interfaces must exist before any rule can name them, and they should exist before the F5 device is attached so that the DMZ has a defined home.

## Components involved

`pa-untrust`, `pa-dmz`, and the `vpn-branch` tunnel interface (created in stage 10). The NGFW is the perimeter: all north-south traffic in this twin crosses it.

## Configure (conceptual)

1. Create layer-3 interfaces: `ethernet1/1` in `untrust` (198.51.100.2/24), `ethernet1/2` in `dmz` (10.20.0.2/24), and `ethernet1/3` in `app` if the application pool sits behind the NGFW.
2. Create security zones `untrust`, `dmz`, `app`, and `management`. Keep `management` separate from the data zones.
3. Add a default route toward the upstream provider in the `untrust` virtual router, and static routes toward `10.30.0.0/24` and `10.40.0.0/24`.
4. Leave the implicit inter-zone deny in place. Do not add rules yet.

## Verify

- Each interface shows its zone and address as in the stage 01 plan.
- The DMZ neighbor (`10.20.0.10`, F5 self-IP) answers a ping from the DMZ side.
- No security rule exists yet, so traffic between zones is denied by default.

## If you do it out of order

Without these zones, stage 07 has nothing to write its rules against, and any rule that appears later will be written against names that were typed by hand. The twin refuses stage 07 until `pa.zones` exists.
